import assert from "node:assert/strict";
import { test } from "node:test";
import MiniSearch from "minisearch";
import { formatIndexLine, tokenizeMemory } from "../text.ts";
import { bumpNotesVersion, listIndexNotes, patchMeta, upsertNote } from "../store.ts";
import type { Note } from "../types.ts";
import { EMPTY_MIND } from "../types.ts";
import { openIsolatedSql } from "../eval-db.ts";
import { setClock } from "../clock.ts";
import { sha256Text } from "../log-refs.ts";
import { getCoreIndexItems, getMemoryIndex, contentMatchCount, pickHotNotes, resetRetrieveCache, resolveCoreIndex } from "./retrieve.ts";
import { buildReflectorInput } from "./reflector.ts";

test("Chinese tokenizer emits bigrams plus latin words", () => {
  const tokens = tokenizeMemory("Rosie 很难过想被叫小猫");
  assert.ok(tokens.includes("rosie"));
  assert.ok(tokens.includes("难过"));
  assert.ok(tokens.includes("小猫"));
  assert.ok(!tokens.includes("很"));
});

test("MiniSearch finds Chinese query by bigram", () => {
  const mini = new MiniSearch({
    fields: ["text"],
    storeFields: ["id"],
    tokenize: tokenizeMemory,
    processTerm: (t) => t,
  });
  mini.addAll([
    { id: "a", text: "她说过难过时别讲道理，叫她小猫" },
    { id: "b", text: "清然在准备解剖考试" },
  ]);
  const hits = mini.search("叫小猫", { tokenize: tokenizeMemory, processTerm: (t) => t });
  assert.equal(hits[0]?.id, "a");
});

test("index line format", () => {
  assert.equal(
    formatIndexLine({
      id: "n1",
      text: "她喜欢被叫小猫，不想听讲道理的安慰方式",
      subject: "rosie",
      localDay: "2026-09-10",
    }),
    "n1|09-10|rosie|她喜欢被叫小猫，不想听讲道理的安慰方式".slice(0, "n1|09-10|rosie|".length + 30),
  );
});

test("resolveCoreIndex expires only on day change, not notesVersion", () => {
  const scored = [
    { id: "a", text: "a", searchText: "a", subject: "rosie" as const, lens: ["diary" as const], weight: 4, happenedAt: 0, localDay: "2026-09-16", recallCount: 0, score: 9 },
    { id: "b", text: "b", searchText: "b", subject: "rosie" as const, lens: ["diary" as const], weight: 4, happenedAt: 0, localDay: "2026-09-16", recallCount: 0, score: 8 },
  ];
  const cached = { version: 3, day: "2026-09-16", ids: ["old"] };
  assert.equal(resolveCoreIndex(cached, 3, "2026-09-16", scored).refresh, false);
  assert.equal(resolveCoreIndex(cached, 99, "2026-09-16", scored).refresh, false);
  assert.equal(resolveCoreIndex(cached, 3, "2026-09-17", scored).refresh, true);
  assert.deepEqual(resolveCoreIndex(cached, 99, "2026-09-17", scored).ids, ["a", "b"]);
});

function note(id: string, text: string): Note {
  return {
    id,
    text,
    tags: ["测"],
    aliases: [],
    subject: "rosie",
    lens: ["diary"],
    fromRosie: true,
    weight: 4,
    status: "active",
    supersededBy: null,
    links: [],
    happenedAt: Date.UTC(2026, 8, 10),
    localDay: "2026-09-10",
    sourceIds: [],
    recallCount: 0,
    lastRecalledAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("content matches ignore filler words", () => {
  assert.equal(contentMatchCount(["今晚", "火锅"]), 1);
  assert.equal(contentMatchCount(["她说", "说今", "今天"]), 0);
  assert.equal(contentMatchCount(["citadel"]), 1);
  assert.equal(contentMatchCount(["电影", "电影"]), 1);
});

test("pickHotNotes keeps mind notes and only adds content matches", async () => {
  const iso = await openIsolatedSql();
  try {
    const mindNotes = [
      note("m1", "Rosie 晚上想写论文但一直开始不了，说打开电脑就想躺"),
      note("m2", "她 Citadel 面试定在周五下午，还没开始准备案例"),
      note("m3", "口腔溃疡又犯了，吃饭都觉得疼"),
      note("m4", "她说熬夜是因为心里过不去那道坎"),
      note("m5", "清然答应过今晚让她一点前睡"),
      note("m6", "她反复说自己不够好，不想听讲道理"),
    ];
    const queryNotes = [
      note("q1", "五道口那家火锅她说过下次想再去吃"),
      note("q2", "新上的那部电影她收藏了，想找天一起看"),
      note("tonight", "答应今晚早点睡"),
      note("filler", "她说今天有点累"),
    ];
    for (const n of [...mindNotes, ...queryNotes]) await upsertNote(n);
    await bumpNotesVersion();
    resetRetrieveCache();

    const picked = await pickHotNotes(
      mindNotes.map((n) => n.id),
      "今晚想吃火锅然后去看电影",
      { },
    );
    assert.deepEqual(picked.queryIds.slice().sort(), ["q1", "q2"]);
    assert.equal(picked.queryIds.includes("tonight"), false);
    assert.equal(picked.queryIds.includes("filler"), false);
    assert.equal(picked.queryScores.length, 2);
    assert.deepEqual(picked.mindIds, ["m1", "m2", "m3", "m4"]);
    assert.equal(picked.notes.length, 6);
    const strict = await pickHotNotes(mindNotes.map((n) => n.id), "今晚想吃火锅然后去看电影", {
      minTerms: 2,
    });
    assert.deepEqual(strict.queryIds, []);
    assert.deepEqual(strict.mindIds, ["m1", "m2", "m3", "m4"]);
  } finally {
    await iso.close();
  }
});

test("pickHotNotes adds strong keyword hits and skips filler", async () => {
  const iso = await openIsolatedSql();
  try {
    await upsertNote(note("only-mind", "她论文还是一个字都没写"));
    await upsertNote(note("q-hotpot", "五道口那家火锅她说过下次想再去吃"));
    await upsertNote(note("q-movie", "新上的那部电影她收藏了，想找天一起看"));
    await upsertNote(note("q-walk", "她想去中央公园散步吹吹风"));
    await upsertNote(note("q-cake", "那家巴斯克蛋糕她上次说还想再买"));
    await upsertNote(note("q-filler", "她说今天有点累"));
    await bumpNotesVersion();
    resetRetrieveCache();

    const picked = await pickHotNotes(["only-mind"], "今晚吃火锅看电影再买蛋糕去公园");
    assert.deepEqual(picked.mindIds, ["only-mind"]);
    assert.equal(picked.queryIds.length, 2);
    assert.equal(picked.queryIds.includes("q-filler"), false);
    for (const id of picked.queryIds) {
      assert.ok(["q-cake", "q-hotpot", "q-movie", "q-walk"].includes(id));
    }
    assert.equal(picked.notes.length, 3);
  } finally {
    await iso.close();
  }
});

test("migration 0010 is idempotent on PGLite", async () => {
  const iso = await openIsolatedSql();
  try {
    const turns = `alter table brain_turns
      add column if not exists jump boolean not null default false,
      add column if not exists jump_score real,
      add column if not exists query_ids text[] not null default '{}',
      add column if not exists query_scores real[] not null default '{}'`;
    const notes = `alter table mem_notes add column if not exists aliases text[] not null default '{}'`;
    await iso.sql.query(turns);
    await iso.sql.query(notes);
    await iso.sql.query(turns);
    await iso.sql.query(notes);
    const cols = await iso.sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where (table_name = 'brain_turns' and column_name in ('jump','jump_score','query_ids','query_scores'))
          or (table_name = 'mem_notes' and column_name = 'aliases')
       order by column_name`,
    );
    assert.deepEqual(
      cols.map((c) => c.column_name),
      ["aliases", "jump", "jump_score", "query_ids", "query_scores"],
    );
  } finally {
    await iso.close();
  }
});

test("MiniSearch matches tags and aliases via searchText without putting them in the prompt", async () => {
  const iso = await openIsolatedSql();
  try {
    await upsertNote(
      note("alias-n", "她周五要去那家投行面试"),
    );
    const withAlias: Note = {
      ...note("alias-n", "她周五要去那家投行面试"),
      tags: ["面试"],
      aliases: ["Citadel", "超级日"],
    };
    await upsertNote(withAlias);
    await bumpNotesVersion();
    resetRetrieveCache();
    const { mini } = await getMemoryIndex();
    assert.ok(mini.search("citadel superday").some((hit) => String(hit.id) === "alias-n"));
    const picked = await pickHotNotes([], "citadel superday");
    assert.deepEqual(picked.queryIds, ["alias-n"]);
    assert.deepEqual(picked.notes.map((n) => n.id), ["alias-n"]);
    assert.equal(
      formatIndexLine({
        id: "alias-n",
        text: withAlias.text,
        subject: "rosie",
        localDay: "2026-09-10",
      }).includes("Citadel"),
      false,
    );
  } finally {
    await iso.close();
  }
});

test("archive without dusk does not change reflector block B", async () => {
  const iso = await openIsolatedSql();
  const at = Date.UTC(2026, 8, 16, 20, 0, 0);
  setClock(() => at);
  try {
    await patchMeta({ timeZone: "America/New_York" });
    for (let i = 0; i < 8; i++) {
      await upsertNote(note(`c${i}`, `Rosie 的长期笔记${i}：论文拖延和睡眠 ${i}`));
    }
    await bumpNotesVersion();
    resetRetrieveCache();
    const day = "2026-09-16";
    const first = await getCoreIndexItems(day);
    assert.ok(first.length >= 1);
    const parts = {
      charter: "你就是清然。",
      selfSummary: "医学院",
      bondSummary: "小猫",
      portrait: [],
      themes: [],
      findings: [],
      clock: "x",
      relatedIndex: [],
      oldMind: EMPTY_MIND,
      conversation: "hi",
    };
    const hash1 = sha256Text(buildReflectorInput({ ...parts, coreIndex: first }).stable);

    await upsertNote(note("new-today", "今晚她说想吃火锅，这是今天新归档的"));
    await bumpNotesVersion();
    const second = await getCoreIndexItems(day);
    assert.deepEqual(
      second.map((i) => i.id),
      first.map((i) => i.id),
    );
    assert.equal(second.some((i) => i.id === "new-today"), false);
    const hash2 = sha256Text(
      buildReflectorInput({ ...parts, coreIndex: second, clock: "later", conversation: "bye" }).stable,
    );
    assert.equal(hash2, hash1);
  } finally {
    setClock(null);
    await iso.close();
  }
});

test("pickHotNotes does not pad to 6 when query has no hits", async () => {
  const iso = await openIsolatedSql();
  try {
    for (let i = 0; i < 8; i++) await upsertNote(note(`pad${i}`, `解剖课笔记${i}：神经元和突触`));
    await upsertNote(note("only-mind", "她论文还是一个字都没写"));
    await bumpNotesVersion();
    resetRetrieveCache();
    const picked = await pickHotNotes(["only-mind"], "");
    assert.equal(picked.notes.length, 1);
    assert.equal(picked.notes[0]!.id, "only-mind");
    assert.equal(picked.queryIds.length, 0);
  } finally {
    await iso.close();
  }
});

test("story seed notes do not get recency bonus", async () => {
  const iso = await openIsolatedSql();
  const ts = Date.UTC(2026, 8, 22, 16, 0, 0);
  setClock(() => ts);
  try {
    await upsertNote({
      ...note("story-n", "故事线：她第一次见清然是在实验室门口"),
      sourceIds: ["story"],
      happenedAt: ts,
      lens: ["bond"],
      weight: 3,
    });
    await upsertNote({
      ...note("fresh-n", "今晚她说想吃五道口那家火锅"),
      sourceIds: [],
      happenedAt: ts,
      lens: ["bond"],
      weight: 3,
    });
    const items = await listIndexNotes();
    const story = items.find((i) => i.id === "story-n");
    const fresh = items.find((i) => i.id === "fresh-n");
    assert.ok(story && fresh, "both notes should be indexed");
    assert.ok(fresh!.score - story!.score > 1.5, `fresh=${fresh!.score} story=${story!.score}`);
  } finally {
    setClock(null);
    await iso.close();
  }
});

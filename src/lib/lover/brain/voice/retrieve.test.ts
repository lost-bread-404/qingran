import assert from "node:assert/strict";
import { test } from "node:test";
import MiniSearch from "minisearch";
import { formatIndexLine, tokenizeMemory } from "../text.ts";
import { bumpNotesVersion, upsertNote } from "../store.ts";
import type { Note } from "../types.ts";
import { openIsolatedSql } from "../eval-db.ts";
import { pickHotNotes, resetRetrieveCache } from "./retrieve.ts";

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

test("pickHotNotes always searches the utterance even when mind gives 6 ids", async () => {
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
    ];
    for (const n of [...mindNotes, ...queryNotes]) await upsertNote(n);
    await bumpNotesVersion();
    resetRetrieveCache();

    const picked = await pickHotNotes(
      mindNotes.map((n) => n.id),
      "今晚想吃火锅然后去看电影",
      { jump: false },
    );
    assert.ok(picked.queryIds.length >= 2, `queryIds=${picked.queryIds.join(",")}`);
    assert.ok(
      picked.queryIds.includes("q1") || picked.notes.some((n) => n.id === "q1"),
      "firepot note should be in query path",
    );
    assert.ok(picked.notes.length <= 6);
    assert.ok(picked.mindIds.length <= 4);
    assert.equal(picked.queryIds.length, picked.queryScores.length);
  } finally {
    await iso.close();
  }
});

test("pickHotNotes jump path takes more query slots and fills a short mind", async () => {
  const iso = await openIsolatedSql();
  try {
    await upsertNote(note("only-mind", "她论文还是一个字都没写"));
    await upsertNote(note("q-hotpot", "五道口那家火锅她说过下次想再去吃"));
    await upsertNote(note("q-movie", "新上的那部电影她收藏了，想找天一起看"));
    await upsertNote(note("q-walk", "她想去中央公园散步吹吹风"));
    await upsertNote(note("q-cake", "那家巴斯克蛋糕她上次说还想再买"));
    await bumpNotesVersion();
    resetRetrieveCache();

    const picked = await pickHotNotes(["only-mind"], "今晚吃火锅看电影再买蛋糕去公园", { jump: true });
    assert.ok(picked.mindIds.includes("only-mind"));
    assert.ok(picked.queryIds.length >= 2);
    assert.ok(picked.notes.length <= 6);
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
    const picked = await pickHotNotes([], "citadel superday", { jump: false });
    assert.ok(picked.queryIds.includes("alias-n") || picked.notes.some((n) => n.id === "alias-n"));
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

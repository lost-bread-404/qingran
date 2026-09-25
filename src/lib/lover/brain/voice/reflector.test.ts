import assert from "node:assert/strict";
import { test } from "node:test";
import { INDEX_CORE_MAX, INDEX_RELATED_MAX } from "../config.ts";
import { EMPTY_MIND, type IndexItem } from "../types.ts";
import { coerceMind, insightDirectiveReason, validateMind } from "../mind-parse.ts";
import { assembleRelatedIndex, resolveCoreIndex } from "./retrieve.ts";
import { buildReflectorInput, formatReflectConversation } from "./reflector.ts";
import { defaultDoc, serializeDoc } from "../prompts/doc.ts";

function item(id: string, extra: Partial<IndexItem> = {}): IndexItem {
  return {
    id,
    text: `笔记${id}`,
    searchText: `笔记${id}`,
    subject: "rosie",
    lens: ["diary"],
    weight: 4,
    happenedAt: 0,
    localDay: "2026-09-14",
    recallCount: 0,
    score: 1,
    ...extra,
  };
}

function pack(over: Partial<Parameters<typeof buildReflectorInput>[0]> = {}) {
  return buildReflectorInput({
    charter: "你就是清然。",
    dossier: "【我自己】\n我在医学院。\n【我们】\n叫她小猫。",
    clock: "2026/9/14周一 23:10",
    oldInner: "feel：她怕自己不够好",
    conversation: "Rosie：又到十一点了",
    ...over,
  });
}

test("a directive insight is dropped instead of kept", () => {
  assert.match(insightDirectiveReason("她现在不需要我推她，不要再催她学习") ?? "", /不要/);
  assert.equal(insightDirectiveReason("她现在需要的是停下来被抱着，不是被推着往前"), null);
  assert.match(insightDirectiveReason("我该去催她") ?? "", /该去/);
  assert.match(insightDirectiveReason("我不应该再提学习") ?? "", /不应该/);
  const next = validateMind(
    { insight: "不要再推她学习", memory_ids: ["n1"] },
    { ...EMPTY_MIND, insight: "旧的" },
    new Set(["n1"]),
  );
  assert.equal(next.insight, "");
  assert.deepEqual(next.memory_ids, []);
  const kept = validateMind(
    { insight: "她现在需要的是停下来被抱着，不是被推着往前", memory_ids: ["n1"] },
    EMPTY_MIND,
    new Set(["n1"]),
  );
  assert.match(kept.insight, /被抱着/);
});

test("validateMind keeps insight and drops unknown memory ids", () => {
  const next = validateMind(
    { insight: "她其实一直在怕被丢掉", memory_ids: ["n1", "ghost"] },
    { ...EMPTY_MIND, insight: "旧的" },
    new Set(["n1"]),
  );
  assert.equal(next.insight, "她其实一直在怕被丢掉");
  assert.deepEqual(next.memory_ids, ["n1"]);
});

test("empty insight clears the mind instead of filling from previous", () => {
  const next = validateMind({ insight: "  ", memory_ids: [] }, { ...EMPTY_MIND, insight: "旧洞察" }, new Set());
  assert.equal(next.insight, "");
  assert.deepEqual(next.memory_ids, []);
});

test("validateMind clips insight without ellipsis", () => {
  const next = validateMind({ insight: "她其实一直在怕被丢掉。".repeat(200), memory_ids: [] }, EMPTY_MIND, new Set());
  assert.ok(next.insight.length <= 1200);
  assert.doesNotMatch(next.insight, /…/);
});

test("coerceMind keeps insight and drops leftover fields from old rows", () => {
  const mind = coerceMind({ insight: "深层", memory_ids: ["n1"], rosie_now: "表面", intent: "接话" }, 3, 9);
  assert.equal(mind.insight, "深层");
  assert.deepEqual(mind.memory_ids, ["n1"]);
  assert.equal(mind.turn_seq, 3);
  assert.equal(mind.updated_at, 9);
  assert.equal("rosie_now" in mind, false);
  assert.equal("intent" in mind, false);
});

test("same day dossier: A and B byte-identical, C changes", () => {
  const a = pack({ clock: "2026/9/14周一 23:10", conversation: "Rosie：第一句", oldInner: "feel：a" });
  const b = pack({ clock: "2026/9/14周一 23:40", conversation: "Rosie：第二句", oldInner: "feel：b" });
  assert.equal(a.system, b.system);
  assert.equal(a.stable, b.stable);
  assert.notEqual(a.turn, b.turn);
});

test("A and B omit clock, old inner, and recent conversation", () => {
  const p = pack();
  for (const s of [p.system, p.stable]) {
    assert.equal(s.includes("2026/9/14周一 23:10"), false);
    assert.equal(s.includes("她怕自己不够好"), false);
    assert.equal(s.includes("Rosie：又到十一点了"), false);
  }
  assert.match(p.turn, /2026\/9\/14周一 23:10/);
  assert.match(p.turn, /她怕自己不够好/);
  assert.match(p.turn, /Rosie：又到十一点了/);
  assert.match(p.stable, /【我记得的】/);
  assert.match(p.system, /你自己此刻的欲望/);
  assert.doesNotMatch(p.system, /不要延续上一刻的计划/);
  assert.doesNotMatch(p.turn, /不要复述/);
});

test("reflect user text comes from the template, not a hardcoded block", () => {
  const doc = defaultDoc("reflect");
  const variant = doc.variants[0];
  if (!variant) throw new Error("missing reflect variant");
  variant.messages[1] = { role: "user", content: "自定义稳定 {dossier}" };
  const packed = buildReflectorInput(
    {
      charter: "你就是清然。",
      dossier: "我在医学院。",
      clock: "现在",
      oldInner: "（空）",
      conversation: "",
    },
    serializeDoc(doc),
  );
  assert.equal(packed.stable, "自定义稳定 我在医学院。");
  assert.match(packed.turn, /【上一次的心思】/);
  assert.doesNotMatch(packed.stable, /【我自己】/);
});

test("reflect turn carries private fields and the busy line, not a reply state block", () => {
  const packed = buildReflectorInput({
    charter: "你就是清然。",
    dossier: "我在医学院。",
    clock: "星期二 21:00（晚上）",
    busyLine: "（只用于决定下一次什么时候找她）我这段时间：考试（很忙）。",
    oldInner: "desire：想抱\nread_her：她累\nchoice：先不催\nplans：\n- id=p1 what=我要问",
    conversation: "清然：过来",
  });
  const all = `${packed.system}\n${packed.stable}\n${packed.turn}`;
  assert.match(packed.turn, /只用于决定下一次什么时候找她/);
  assert.match(packed.turn, /read_her：她累/);
  assert.match(packed.turn, /choice：先不催/);
  assert.match(packed.turn, /我要问/);
  assert.match(packed.system, /scene/);
  assert.doesNotMatch(all, /⟦心⟧/);
});

test("reflect conversation drops markup, night noise, and system notices", () => {
  const text = formatReflectConversation(
    [
      {
        id: "n",
        role: "assistant",
        text: "⟦夜噪⟧咳",
        createdAt: 1,
        kind: "say",
        archivedAt: null,
        sessionId: null,
        localDay: null,
      },
      {
        id: "s",
        role: "assistant",
        text: "系统",
        createdAt: 2,
        kind: "system_notice",
        archivedAt: null,
        sessionId: null,
        localDay: null,
      },
      {
        id: "a",
        role: "assistant",
        text: "⟦回:u1⟧过来。",
        createdAt: 3,
        kind: "say",
        archivedAt: null,
        sessionId: null,
        localDay: null,
      },
    ],
    "UTC",
  );
  assert.match(text, /过来/);
  assert.doesNotMatch(text, /⟦回:/);
  assert.doesNotMatch(text, /系统/);
  assert.doesNotMatch(text, /咳/);
});

test("core index caps at 60, sorted by id; related caps at 30 and excludes core", () => {
  const scored = Array.from({ length: 80 }, (_, i) => item(`n${String(i).padStart(3, "0")}`, { score: 80 - i }));
  const resolved = resolveCoreIndex(null, 1, "2026-09-14", scored);
  assert.equal(resolved.refresh, true);
  assert.equal(resolved.ids.length, INDEX_CORE_MAX);
  const coreIds = new Set(resolved.ids);
  const related = assembleRelatedIndex({
    coreIds,
    recentHeavy: [item("n000"), item("extra-recent")],
    searchHits: [
      { id: "n000", score: 9 },
      { id: "hit-1", score: 5 },
      { id: "hit-low", score: 0.1 },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `hit-${i + 2}`, score: 4 - i / 100 })),
    ],
    itemsById: new Map(
      ["extra-recent", "hit-1", "hit-low", ...Array.from({ length: 40 }, (_, i) => `hit-${i + 2}`)].map((id) => [
        id,
        item(id),
      ]),
    ),
  });
  assert.ok(related.length <= INDEX_RELATED_MAX);
  assert.ok(related.every((r) => !coreIds.has(r.id)));
  assert.ok(related.some((r) => r.id === "extra-recent"));
  assert.equal(related.some((r) => r.id === "n000"), false);
  assert.equal(related.some((r) => r.id === "hit-low"), false);
});

test("memory_ids outside core ∪ related are dropped", () => {
  const allowed = new Set(["n1", "n9"]);
  const next = validateMind({ memory_ids: ["n1", "ghost", "n9"] }, EMPTY_MIND, allowed);
  assert.deepEqual(next.memory_ids, ["n1", "n9"]);
});

test("core index refreshes only when the local day changes", () => {
  const scored = [item("a", { score: 9 }), item("b", { score: 8 })];
  const cached = { version: 3, day: "2026-09-14", ids: ["old"] };
  assert.deepEqual(resolveCoreIndex(cached, 3, "2026-09-14", scored), { ids: ["old"], refresh: false });
  assert.equal(resolveCoreIndex(cached, 4, "2026-09-14", scored).refresh, false);
  assert.equal(resolveCoreIndex(cached, 3, "2026-09-15", scored).refresh, true);
  assert.deepEqual(resolveCoreIndex(cached, 4, "2026-09-15", scored).ids, ["a", "b"]);
});

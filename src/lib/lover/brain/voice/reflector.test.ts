import assert from "node:assert/strict";
import { test } from "node:test";
import { INDEX_CORE_MAX, INDEX_RELATED_MAX } from "../config.ts";
import { EMPTY_MIND, type IndexItem, type Mind, type PortraitRow, type Theme } from "../types.ts";
import { coerceMind, insightDirectiveReason, validateMind } from "../mind-parse.ts";
import { assembleRelatedIndex, resolveCoreIndex } from "./retrieve.ts";
import { buildReflectorInput } from "./reflector.ts";
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

const portrait = (topic: string, id = topic): PortraitRow => ({
  id,
  topic,
  body: `${topic}的样子`,
  status: "active",
  kind: "trait",
  evidenceIds: [],
  lastSeen: 0,
  lastSupportedAt: 0,
  supportCount: 1,
  updatedAt: 0,
});

const theme = (id: string, name: string): Theme => ({
  id,
  name,
  definition: `${name}的定义`,
  version: 1,
  status: "active",
  mergedInto: null,
  parentId: null,
  userFeedback: null,
  createdAt: 0,
  updatedAt: 0,
});

function pack(over: Partial<Parameters<typeof buildReflectorInput>[0]> = {}) {
  const mind: Mind = {
    ...EMPTY_MIND,
    insight: "她怕自己不够好",
  };
  return buildReflectorInput({
    charter: "你就是清然。",
    selfSummary: "我在医学院。",
    bondSummary: "叫她小猫。",
    portrait: [portrait("安慰", "p2"), portrait("压力", "p1")],
    themes: [theme("t-b", "论文"), theme("t-a", "睡眠")],
    findings: [
      { id: "f-b", line: "- 「熬夜」之后常出现「启动困难」" },
      { id: "f-a", line: "- 「运动」之后常好转" },
    ],
    coreIndex: [item("n2"), item("n1")],
    clock: "2026/9/14周一 23:10",
    relatedIndex: [item("n9")],
    oldMind: mind,
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
  const next = validateMind(
    { insight: "  ", memory_ids: [] },
    { ...EMPTY_MIND, insight: "旧洞察" },
    new Set(),
  );
  assert.equal(next.insight, "");
  assert.deepEqual(next.memory_ids, []);
});

test("validateMind clips insight without ellipsis", () => {
  const next = validateMind({ insight: "她其实一直在怕被丢掉。".repeat(200), memory_ids: [] }, EMPTY_MIND, new Set());
  assert.ok(next.insight.length <= 1200);
  assert.doesNotMatch(next.insight, /…/);
});

test("coerceMind keeps insight and drops leftover fields from old rows", () => {
  const mind = coerceMind(
    { insight: "深层", memory_ids: ["n1"], rosie_now: "表面", intent: "接话" },
    3,
    9,
  );
  assert.equal(mind.insight, "深层");
  assert.deepEqual(mind.memory_ids, ["n1"]);
  assert.equal(mind.turn_seq, 3);
  assert.equal(mind.updated_at, 9);
  assert.equal("rosie_now" in mind, false);
  assert.equal("intent" in mind, false);
});

test("same day same notes: A and B byte-identical, C changes", () => {
  const a = pack({ clock: "2026/9/14周一 23:10", conversation: "Rosie：第一句", oldMind: { ...EMPTY_MIND, insight: "a" } });
  const b = pack({ clock: "2026/9/14周一 23:40", conversation: "Rosie：第二句", oldMind: { ...EMPTY_MIND, insight: "b" } });
  assert.equal(a.system, b.system);
  assert.equal(a.stable, b.stable);
  assert.notEqual(a.turn, b.turn);
});

test("A and B omit clock, old mind, and recent conversation", () => {
  const p = pack();
  for (const s of [p.system, p.stable]) {
    assert.equal(s.includes("2026/9/14周一 23:10"), false);
    assert.equal(s.includes("她怕自己不够好"), false);
    assert.equal(s.includes("Rosie：又到十一点了"), false);
    assert.equal(s.includes("turn_seq"), false);
  }
  assert.match(p.turn, /2026\/9\/14周一 23:10/);
  assert.match(p.turn, /她怕自己不够好/);
  assert.match(p.turn, /Rosie：又到十一点了/);
  assert.match(p.turn, /没有深层洞察时 insight 必须是空字符串/);
  assert.match(p.system, /不要延续上一刻的计划/);
  assert.match(p.system, /宁可空着/);
});

test("portrait themes findings core index sort is deterministic", () => {
  const p = pack();
  const portraitPos = p.stable.indexOf("压力：");
  const comfortPos = p.stable.indexOf("安慰：");
  assert.ok(portraitPos >= 0 && comfortPos > portraitPos);
  const sleepPos = p.stable.indexOf("睡眠");
  const paperPos = p.stable.indexOf("论文");
  assert.ok(sleepPos >= 0 && paperPos > sleepPos);
  const fa = p.stable.indexOf("运动");
  const fb = p.stable.indexOf("熬夜");
  assert.ok(fa >= 0 && fb > fa);
  const n1 = p.stable.indexOf("n1|");
  const n2 = p.stable.indexOf("n2|");
  assert.ok(n1 >= 0 && n2 > n1);
  assert.match(p.stable, /【她的长期规律·主题】/);
  assert.match(p.stable, /【记忆 index · 核心】/);
  assert.doesNotMatch(p.stable, /只输出 insight/);
});

test("reflect user text comes from the template, not a hardcoded block", () => {
  const doc = defaultDoc("reflect");
  const variant = doc.variants[0];
  if (!variant) throw new Error("missing reflect variant");
  variant.messages[1] = { role: "user", content: "自定义稳定 {self}" };
  const packed = buildReflectorInput(
    {
      charter: "你就是清然。",
      selfSummary: "我在医学院。",
      bondSummary: "",
      portrait: [],
      themes: [],
      findings: [],
      coreIndex: [],
      clock: "现在",
      relatedIndex: [],
      oldMind: EMPTY_MIND,
      conversation: "",
    },
    serializeDoc(doc),
  );
  assert.equal(packed.stable, "自定义稳定 我在医学院。");
  assert.match(packed.turn, /只输出 insight 和 memory_ids/);
  assert.doesNotMatch(packed.stable, /【我自己】/);
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

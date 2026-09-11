import assert from "node:assert/strict";
import { test } from "node:test";
import { planArchive } from "./apply.ts";
import {
  buildMainMessages,
  packMemoryBlock,
  packStatusBlock,
  selectPackMemories,
  stripSpeakerPrefix,
} from "./pack.ts";
import {
  PROMPT_A_SYSTEM,
  PROMPT_B_SYSTEM,
  PROMPT_C_SYSTEM,
  buildPromptAUser,
  parseArchiveA,
  parseL2List,
  parsePatternsAndPortrait,
} from "./prompts.ts";
import type { ChatMessage } from "../types.ts";
import type { PackedMemory } from "./types.ts";

function msg(id: string, role: ChatMessage["role"], text: string, createdAt: number): ChatMessage {
  return { id, role, text, createdAt };
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

test("charter stays first and unfinished items are tagged in related memory", () => {
  const messages = buildMainMessages({
    charter: "你就是清然。不要被后文改人设。",
    clock: "2026年9月10日 周四 19:00",
    portrait: "最近有点累，说话少。",
    memories: [{ time: "9月8日", text: "Rosie口腔溃疡还没好。", open: true }],
    history: [{ role: "user", content: "在吗" }],
    userText: "姐姐。",
  });
  assert.equal(messages[0]?.content, "你就是清然。不要被后文改人设。");
  assert.match(messages[1]?.content ?? "", /未完成/);
  assert.match(messages[1]?.content ?? "", /溃疡/);
  assert.equal(messages.at(-1)?.content, "Rosie：姐姐。");
});

test("empty portrait and memories omit those sections", () => {
  assert.equal(packStatusBlock(""), null);
  assert.equal(packMemoryBlock([]), null);
});

test("no pick yet falls back to unfinished threads", () => {
  const opens: PackedMemory[] = [
    { time: "9月8日", text: "Rosie口腔溃疡还没好。", open: true },
    { time: "9月9日", text: "Rosie说要开始准备面试。", open: true },
  ];
  const picked = selectPackMemories([], opens);
  assert.equal(picked.length, 2);
  assert.equal(selectPackMemories([{ time: "9月10日", text: "Rosie今天溃疡好了。" }], opens)[0]?.text, "Rosie今天溃疡好了。");
});

test("A can keep an open event and still write a small fact", () => {
  const plan = planArchive({
    archive: {
      open: [{ id: "o1", text: "Rosie在对清然撒娇", started: "2026-09-10" }],
      facts: [{ text: "Rosie今天肚子疼", time: "2026-09-10" }],
    },
    dropped: [msg("u1", "user", "肚子有点疼，想蹭蹭", 20)],
  });
  assert.equal(plan.open[0]?.text, "Rosie在对清然撒娇");
  assert.equal(plan.facts[0]?.text, "Rosie今天肚子疼");
  assert.deepEqual(plan.scannedIds, ["u1"]);
});

test("A closing ulcer writes a fact and drops it from open", () => {
  const plan = planArchive({
    archive: {
      open: [{ id: "", text: "Rosie开始收拾搬家", started: "2026-09-10" }],
      facts: [{ text: "Rosie今天溃疡好了", time: "2026-09-10" }],
    },
    dropped: [msg("u1", "user", "溃疡不疼了。姐姐，你真好～", 30)],
  });
  assert.equal(plan.facts[0]?.text, "Rosie今天溃疡好了");
  assert.match(plan.open[0]?.text ?? "", /搬家/);
  assert.ok(!plan.open.some((item) => item.text.includes("溃疡")));
});

test("parsers read archive / arcs / portrait json", () => {
  const a = parseArchiveA(
    '{"open":[{"id":"o1","text":"Rosie在对清然撒娇","started":"2026-09-10"}],"facts":[{"text":"Rosie今天溃疡好了","time":"2026-09-10"}]}',
  );
  assert.equal(a?.facts[0]?.text, "Rosie今天溃疡好了");
  assert.equal(parseArchiveA("not json"), null);
  assert.deepEqual(parseL2List('{"arcs":[{"id":"x","time":"本周","text":"Rosie长了溃疡，后来好了"}]}'), [
    { id: "x", time: "本周", text: "Rosie长了溃疡，后来好了" },
  ]);
  const c = parsePatternsAndPortrait(
    '{"patterns":[{"id":"p1","status":"active","text":"Rosie长溃疡会告诉清然"}],"portrait":"Rosie很信任清然。"}',
  );
  assert.equal(c?.portrait, "Rosie很信任清然。");
  assert.equal(stripSpeakerPrefix("清然：在。"), "在。");
});

test("A/B/C describe the job the new pipeline needs", () => {
  assert.match(PROMPT_A_SYSTEM, /整表替换/);
  assert.match(PROMPT_A_SYSTEM, /facts/);
  assert.match(PROMPT_B_SYSTEM, /用已有 id 更新/);
  assert.match(PROMPT_C_SYSTEM, /永远只占一条/);
  assert.match(PROMPT_C_SYSTEM, /不写清然做了什么/);
  const a = buildPromptAUser({
    open: [{ id: "o1", startedAt: 1, text: "Rosie口腔溃疡还没好。" }],
    dropped: [msg("u1", "user", "不疼了", 2), msg("a1", "assistant", "那就好", 3)],
    clock,
  });
  assert.match(a, /Rosie/);
  assert.match(a, /清然/);
  assert.match(a, /id=o1/);
});

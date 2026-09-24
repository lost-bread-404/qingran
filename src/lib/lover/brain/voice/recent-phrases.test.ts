import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EMPTY_MIND } from "../types.ts";
import { promptSpec } from "../prompts/catalog.ts";
import { defaultDoc, variantMessages } from "../prompts/doc.ts";
import { fillTemplate } from "../prompts/fill.ts";
import { ensureVoiceRecentPhrases } from "../prompts/templates.ts";
import { buildVoiceMessages } from "./pack-build.ts";
import {
  formatRecentPhrases,
  normalizeForRepeat,
  omitEmptyRecentPhraseBlock,
  recentPhrasesFromHistory,
  recentRepeatedPhrases,
} from "./recent-phrases.ts";

const LINE = "我把你抱得更紧，手臂圈住你的腰";

function say(id: string, role: "user" | "assistant", text: string, at: number) {
  return {
    id,
    role,
    text,
    createdAt: at,
    kind: "say" as const,
    archivedAt: null,
    sessionId: "s",
    localDay: "2026-09-15",
  };
}

function systemText(history: ReturnType<typeof say>[]) {
  return buildVoiceMessages({
    charter: "你就是清然。",
    history,
    userText: "嗯",
    mind: EMPTY_MIND,
    notes: [],
    clock: "星期二 21:00",
    timeZone: "UTC",
  })
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

test("normalization drops punctuation and modal particles", () => {
  assert.equal(normalizeForRepeat(`嗯……${LINE}啊。`), normalizeForRepeat(LINE));
  assert.equal(normalizeForRepeat("好的呀"), "好的");
});

test("repeated narration becomes recent_phrases; a one-off does not", () => {
  const phrases = recentRepeatedPhrases([
    `${LINE}。`,
    `嗯……${LINE}啊，声音低下去。`,
    "今晚风很大。",
  ]);
  assert.ok(phrases.some((phrase) => phrase.includes("我把你抱得更紧") && phrase.includes("手臂圈住你的腰")));
  assert.equal(recentRepeatedPhrases([`${LINE}。`, "今晚风很大。"]).length, 0);
  assert.equal(recentRepeatedPhrases(["好的呀。", "好的啊。"]).length, 0);
  assert.equal(formatRecentPhrases([]), "");
});

test("only the last 8 replies count, and at most 8 phrases are kept", () => {
  const old = "很早以前才说过的那一句旁白";
  const recent = Array.from({ length: 8 }, (_, i) => `这句彼此不同${i}完全不重复`);
  assert.equal(recentRepeatedPhrases([old, old, ...recent]).length, 0);

  const lines = Array.from({ length: 9 }, (_, i) => `独立句子${i}戊己庚辛。`);
  const many = recentRepeatedPhrases([`甲开头。${lines.join("")}`, `乙开头。${lines.join("")}`]);
  assert.equal(many.length, 8);
});

test("user lines and night noise are not qingran replies", () => {
  const history = [
    say("a1", "assistant", `${LINE}。`, 1),
    say("u1", "user", `${LINE}。`, 2),
    say("n1", "assistant", `⟦夜噪⟧${LINE}。`, 3),
  ];
  assert.equal(recentPhrasesFromHistory(history).length, 0);
  const repeated = recentPhrasesFromHistory([
    say("a1", "assistant", `${LINE}。`, 1),
    say("u1", "user", "抱紧一点", 2),
    say("a2", "assistant", `${LINE}。`, 3),
  ]);
  assert.ok(repeated.some((phrase) => phrase.includes("手臂圈住你的腰")));
});

test("placeholder contains a repeated phrase, and is omitted when there is none", () => {
  const voice = promptSpec("voice");
  assert.ok(voice.placeholders.some((row) => row.token === "recent_phrases"));
  const template = variantMessages(defaultDoc("voice"), "main")
    .map((message) => message.content)
    .join("\n\n");
  assert.match(template, /\{recent_phrases\}/);
  assert.match(template, /不要再重复这些句子/);

  const withRepeat = systemText([
    say("a1", "assistant", `${LINE}。`, 1),
    say("u1", "user", "别松手", 2),
    say("a2", "assistant", `${LINE}。`, 3),
  ]);
  assert.match(withRepeat, /这些话你最近说过：「我把你抱得更紧，手臂圈住你的腰」/);
  assert.match(withRepeat, /不要再重复这些句子/);
  assert.match(withRepeat, /场景没变就不用再描述一次动作/);
  assert.doesNotMatch(withRepeat, /\{recent_phrases\}/);

  const none = systemText([
    say("a1", "assistant", "我在。", 1),
    say("u1", "user", "嗯", 2),
    say("a2", "assistant", "先睡吧。", 3),
  ]);
  assert.equal(formatRecentPhrases(recentPhrasesFromHistory([
    say("a1", "assistant", "我在。", 1),
    say("a2", "assistant", "先睡吧。", 3),
  ])), "");
  assert.doesNotMatch(none, /这些话你最近说过/);
  assert.doesNotMatch(none, /不要再重复这些句子/);
  assert.doesNotMatch(none, /\{recent_phrases\}/);
  assert.match(none, /说话要有逻辑/);

  const omitted = omitEmptyRecentPhraseBlock(template, "");
  assert.doesNotMatch(omitted, /这些话你最近说过/);
  assert.match(omitted, /说话要有逻辑/);
  const filled = fillTemplate(template, { recent_phrases: formatRecentPhrases([LINE]) });
  assert.match(filled, /这些话你最近说过：「我把你抱得更紧，手臂圈住你的腰」。不要再重复这些句子/);
});

test("an older reply template gains the editable sentence once", () => {
  const messages = [
    { role: "system" as const, content: "说话要有逻辑：前后一致。" },
    { role: "user" as const, content: "{user_text}" },
  ];
  ensureVoiceRecentPhrases(messages);
  assert.match(messages[0]!.content, /\{recent_phrases\}/);
  assert.match(messages[0]!.content, /这些话你最近说过/);
  const once = messages[0]!.content;
  ensureVoiceRecentPhrases(messages);
  assert.equal(messages[0]!.content, once);

  const moved = [
    { role: "system" as const, content: "说话要有逻辑" },
    { role: "system" as const, content: "别的位置 {recent_phrases}" },
  ];
  ensureVoiceRecentPhrases(moved);
  assert.equal(moved[0]!.content, "说话要有逻辑");
});

test("turn traces record the phrases extracted for the reply", () => {
  const talk = readFileSync(new URL("../../../../routes/api/talk.ts", import.meta.url), "utf8");
  assert.match(talk, /recentPhrases: ctx\.recentPhrases/);
  const trace = readFileSync(new URL("../turn-trace.ts", import.meta.url), "utf8");
  assert.match(trace, /recentPhrases\?: string\[\]/);
});

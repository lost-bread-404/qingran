import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STT_KEYTERMS, xaiVadThreshold } from "./config.ts";

test("xAI STT pins grok-voice-transcribe-2.0 and omits undocumented prompt", () => {
  const src = readFileSync(new URL("./xai.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /append\(\s*["']language["']/);
  assert.doesNotMatch(src, /append\(\s*["']prompt["']/);
  assert.match(src, /append\(\s*["']model["']\s*,\s*HEARING\.xai\.model\)/);
  assert.match(src, /append\(\s*["']keyterm["']/);
  assert.match(src, /STT_KEYTERMS/);
  assert.doesNotMatch(src, /sttKeyterms\(/);
  assert.doesNotMatch(src, /mergeKeyterms/);
  assert.match(src, /filler_words/);
  assert.match(src, /xaiVadThreshold/);
  assert.doesNotMatch(src, /vad_threshold", "0"/);
});

test("config model is grok-voice-transcribe-2.0 and vad defaults to 0.3", () => {
  const src = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
  assert.match(src, /grok-voice-transcribe-2\.0/);
  assert.match(src, /export const STT_KEYTERMS/);
  assert.equal(xaiVadThreshold(), 0.3);
});

test("STT_KEYTERMS is the slim configurable list in hearing/config.ts", () => {
  assert.deepEqual([...STT_KEYTERMS], [
    "姐姐",
    "清然",
    "小猫",
    "Rosie",
    "嗯",
    "啊",
    "呜",
    "哈",
    "哼",
    "哦",
    "唉",
    "嘛",
    "呀",
    "啦",
    "呢",
    "吧",
    "喵",
    "嗷",
    "嗷呜",
    "喵呜",
    "呜喵",
  ]);
  assert.equal(STT_KEYTERMS.includes("林泽"), false);
  assert.equal(STT_KEYTERMS.includes("嗯嗯"), false);
  assert.equal(STT_KEYTERMS.includes("嗯嗯嗯"), false);
  assert.equal(STT_KEYTERMS.includes("啊啊"), false);
  assert.equal(STT_KEYTERMS.includes("嗷"), true);
  assert.equal(STT_KEYTERMS.includes("信息素"), false);
  const stt = readFileSync(new URL("../stt-text.ts", import.meta.url), "utf8");
  assert.doesNotMatch(stt, /ABO_TERMS/);
  assert.doesNotMatch(stt, /export const STT_KEYTERMS\s*=/);
});

test("hallucination compare script adds vad0.3+new using the same STT_KEYTERMS", () => {
  const script = readFileSync(new URL("../../../../scripts/xai-hallucination-compare.mjs", import.meta.url), "utf8");
  assert.match(script, /vad0\.3\+new/);
  const block = script.match(/const NEW_FIXED = \[([\s\S]*?)\];/);
  assert.ok(block, "NEW_FIXED list is missing");
  const terms = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(terms, [...STT_KEYTERMS]);
});

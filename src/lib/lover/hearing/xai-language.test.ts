import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { xaiVadThreshold } from "./config.ts";

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
  assert.equal(xaiVadThreshold(), 0.3);
});

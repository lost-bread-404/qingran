import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("xAI STT pins grok-voice-transcribe-2.0 and omits undocumented prompt", () => {
  const src = readFileSync(new URL("./xai.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /append\(\s*["']language["']/);
  assert.doesNotMatch(src, /append\(\s*["']prompt["']/);
  assert.match(src, /append\(\s*["']model["']\s*,\s*HEARING\.xai\.model\)/);
  assert.match(src, /append\(\s*["']keyterm["']/);
  assert.match(src, /filler_words/);
  assert.match(src, /vad_threshold/);
});

test("config model is grok-voice-transcribe-2.0", () => {
  const src = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
  assert.match(src, /grok-voice-transcribe-2\.0/);
});

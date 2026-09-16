import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldFlushSpoken, ttsSpeed, TTS_SPEED_SOFT } from "./tts.ts";

test("first spoken flush waits for a sentence end", () => {
  assert.equal(shouldFlushSpoken("我想你了", true), false);
  assert.equal(shouldFlushSpoken("我想你了。", true), true);
  assert.equal(shouldFlushSpoken("今晚呢？", true), true);
});

test("later flushes stay on the same stream after a sentence", () => {
  assert.equal(shouldFlushSpoken("过来。", false), true);
  assert.equal(shouldFlushSpoken("还没有句号的半句", false), false);
});

test("soft voice uses Eve's slowest natural speed", () => {
  assert.equal(ttsSpeed(false), 1);
  assert.equal(ttsSpeed(true), TTS_SPEED_SOFT);
  assert.equal(TTS_SPEED_SOFT, 0.7);
});


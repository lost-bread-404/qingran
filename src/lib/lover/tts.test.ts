import assert from "node:assert/strict";
import { test } from "node:test";
import { nextVoiceRate, shouldFlushSpoken, snapVoiceRate, ttsSpeed } from "./tts.ts";

test("first spoken flush waits for a sentence end", () => {
  assert.equal(shouldFlushSpoken("我想你了", true), false);
  assert.equal(shouldFlushSpoken("我想你了。", true), true);
  assert.equal(shouldFlushSpoken("今晚呢？", true), true);
});

test("later flushes stay on the same stream after a sentence", () => {
  assert.equal(shouldFlushSpoken("过来。", false), true);
  assert.equal(shouldFlushSpoken("还没有句号的半句", false), false);
});

test("voice speed cycles through four natural Eve rates", () => {
  assert.equal(snapVoiceRate(1).label, "平常");
  assert.equal(nextVoiceRate(1).label, "轻缓");
  assert.equal(nextVoiceRate(0.92).label, "慢");
  assert.equal(nextVoiceRate(0.85).label, "稍快");
  assert.equal(nextVoiceRate(1.12).label, "平常");
  assert.equal(ttsSpeed(0.7), 0.85);
  assert.equal(ttsSpeed(0.9), 0.92);
});

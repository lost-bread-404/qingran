import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldSendDelta } from "./tts.ts";

test("does not split TTS mid-sentence by length", () => {
  assert.equal(shouldSendDelta("我想你了", true), false);
  assert.equal(shouldSendDelta("我想你了，今晚有点想靠近你", true), false);
  assert.equal(shouldSendDelta("我想你了。", true), true);
  assert.equal(shouldSendDelta("今晚呢？", true), true);
});

test("only dumps a long unpunctuated chunk as a last resort", () => {
  assert.equal(shouldSendDelta("啊".repeat(40), true), false);
  assert.equal(shouldSendDelta("啊".repeat(96), true), true);
});

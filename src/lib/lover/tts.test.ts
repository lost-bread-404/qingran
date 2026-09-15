import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldFlushSpoken } from "./tts.ts";

test("first spoken flush waits for a sentence end", () => {
  assert.equal(shouldFlushSpoken("我想你了", true), false);
  assert.equal(shouldFlushSpoken("我想你了。", true), true);
  assert.equal(shouldFlushSpoken("今晚呢？", true), true);
});

test("later flushes stay on the same stream after a sentence", () => {
  assert.equal(shouldFlushSpoken("过来。", false), true);
  assert.equal(shouldFlushSpoken("还没有句号的半句", false), false);
});

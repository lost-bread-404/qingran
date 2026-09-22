import assert from "node:assert/strict";
import { test } from "node:test";
import { clampReplyDownTags, countReplyDownTags, REPLY_DOWN_TAGS } from "./reply-feedback.ts";

test("clampReplyDownTags keeps known tags in order and drops junk", () => {
  assert.deepEqual(clampReplyDownTags(["空话", "空话", "太长", "未知", 1, null]), ["空话", "太长"]);
  assert.deepEqual(clampReplyDownTags(undefined), []);
  assert.deepEqual(REPLY_DOWN_TAGS, ["没懂我", "太强势", "空话", "太长", "太短", "重复", "出戏"]);
});

test("countReplyDownTags counts every preset even when unused", () => {
  const counts = countReplyDownTags([
    { tags: ["没懂我", "空话"] },
    { tags: ["没懂我"] },
    { tags: ["胡说"] },
  ]);
  assert.equal(counts.find((row) => row.tag === "没懂我")?.n, 2);
  assert.equal(counts.find((row) => row.tag === "空话")?.n, 1);
  assert.equal(counts.find((row) => row.tag === "出戏")?.n, 0);
  assert.equal(counts.length, REPLY_DOWN_TAGS.length);
});

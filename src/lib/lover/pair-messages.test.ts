import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dropIncompleteReplies,
  pairMessages,
  sortConversation,
} from "./pair-messages.ts";
import type { ChatMessage } from "./types.ts";

function msg(
  id: string,
  role: ChatMessage["role"],
  text: string,
  createdAt = 1,
): ChatMessage {
  return { id, role, text, createdAt };
}

test("pairMessages zips user and assistant in order", () => {
  const pairs = pairMessages([
    msg("u1", "user", "一", 1),
    msg("a1", "assistant", "回一", 2),
    msg("u2", "user", "二", 3),
    msg("a2", "assistant", "回二", 4),
  ]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0]?.user?.id, "u1");
  assert.equal(pairs[0]?.assistant?.id, "a1");
  assert.equal(pairs[1]?.user?.id, "u2");
  assert.equal(pairs[1]?.assistant?.id, "a2");
});

test("pairMessages matches stacked users to later replies", () => {
  const pairs = pairMessages([
    msg("u1", "user", "一", 1),
    msg("u2", "user", "二", 2),
    msg("a1", "assistant", "回一", 3),
    msg("a2", "assistant", "回二", 4),
  ]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0]?.user?.id, "u1");
  assert.equal(pairs[0]?.assistant?.id, "a1");
  assert.equal(pairs[1]?.user?.id, "u2");
  assert.equal(pairs[1]?.assistant?.id, "a2");
});

test("sortConversation keeps user before assistant when timestamps match", () => {
  const sorted = sortConversation([
    msg("a1", "assistant", "回一", 10),
    msg("u1", "user", "一", 10),
  ]);
  assert.equal(sorted[0]?.role, "user");
  assert.equal(sorted[1]?.role, "assistant");
});

test("dropIncompleteReplies removes trailing empty assistant", () => {
  const next = dropIncompleteReplies([
    msg("u1", "user", "一"),
    msg("a1", "assistant", ""),
  ]);
  assert.equal(next.length, 1);
  assert.equal(next[0]?.id, "u1");
});

test("dropIncompleteReplies keeps an in-flight empty assistant", () => {
  const next = dropIncompleteReplies(
    [msg("u1", "user", "一"), msg("a1", "assistant", "")],
    ["a1"],
  );
  assert.equal(next.length, 2);
  assert.equal(next[1]?.id, "a1");
});

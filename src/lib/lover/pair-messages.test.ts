import assert from "node:assert/strict";
import { test } from "node:test";
import { UNRECOGNIZED_TEXT } from "./hearing/heard.ts";
import { INTERRUPTED_MARK } from "./interrupt.ts";
import { decodeStoredBody, encodeStoredMessage, mergeEditedUserBody } from "./message-markup.ts";
import {
  dropIncompleteReplies,
  historyForQingran,
  pairMessages,
  shownReply,
  skipsQingran,
  sortConversation,
  unselectedReplyIds,
} from "./pair-messages.ts";
import type { ChatMessage } from "./types.ts";

function msg(
  id: string,
  role: ChatMessage["role"],
  text: string,
  createdAt = 1,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, text, createdAt, ...extra };
}

test("pairMessages zips user and assistant in order", () => {
  const pairs = pairMessages([
    msg("u1", "user", "一", 1),
    msg("a1", "assistant", "回一", 2, { replyTo: "u1" }),
    msg("u2", "user", "二", 3),
    msg("a2", "assistant", "回二", 4, { replyTo: "u2" }),
  ]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0]?.user?.id, "u1");
  assert.equal(pairs[0]?.assistant?.id, "a1");
  assert.equal(pairs[1]?.user?.id, "u2");
  assert.equal(pairs[1]?.assistant?.id, "a2");
});

test("unheard users stay unmatched so later replies keep their own turn", () => {
  const pairs = pairMessages([
    msg("miss", "user", UNRECOGNIZED_TEXT, 1, { kind: "unheard" }),
    msg("a", "user", "A", 2),
    msg("ra", "assistant", "reply A", 3, { replyTo: "a" }),
    msg("b", "user", "B", 4),
    msg("rb", "assistant", "reply B", 5, { replyTo: "b" }),
  ]);
  assert.equal(pairs.length, 3);
  assert.equal(pairs[0]?.user?.id, "miss");
  assert.equal(pairs[0]?.assistant, undefined);
  assert.equal(pairs[1]?.user?.id, "a");
  assert.equal(pairs[1]?.assistant?.id, "ra");
  assert.equal(pairs[2]?.user?.id, "b");
  assert.equal(pairs[2]?.assistant?.id, "rb");
});

test("stacked unheard then A/replyA/B/replyB stay in time order", () => {
  const pairs = pairMessages([
    msg("m1", "user", UNRECOGNIZED_TEXT, 1, { kind: "unheard" }),
    msg("m2", "user", UNRECOGNIZED_TEXT, 2, { kind: "unheard" }),
    msg("a", "user", "A", 3),
    msg("ra", "assistant", "replyA", 4, { replyTo: "a" }),
    msg("b", "user", "B", 5),
    msg("rb", "assistant", "replyB", 6, { replyTo: "b" }),
  ]);
  assert.deepEqual(
    pairs.flatMap((p) => [p.user?.text, p.assistant?.text].filter(Boolean)),
    [UNRECOGNIZED_TEXT, UNRECOGNIZED_TEXT, "A", "replyA", "B", "replyB"],
  );
  assert.equal(pairs[0]?.assistant, undefined);
  assert.equal(pairs[1]?.assistant, undefined);
  assert.equal(pairs[2]?.assistant?.id, "ra");
  assert.equal(pairs[3]?.assistant?.id, "rb");
});

test("old messages without replyTo render in createdAt order", () => {
  const pairs = pairMessages([
    msg("m1", "user", UNRECOGNIZED_TEXT, 1),
    msg("a", "user", "A", 2),
    msg("ra", "assistant", "replyA", 3),
    msg("b", "user", "B", 4),
    msg("rb", "assistant", "replyB", 5),
  ]);
  assert.deepEqual(
    pairs.map((p) => p.user?.id ?? p.assistant?.id),
    ["m1", "a", "ra", "b", "rb"],
  );
  assert.equal(pairs[1]?.assistant, undefined);
});

test("historyForQingran drops unheard and notes", () => {
  const history = historyForQingran([
    msg("m1", "user", UNRECOGNIZED_TEXT, 1, { kind: "unheard" }),
    msg("a", "user", "A", 2),
    msg("ra", "assistant", "replyA", 3, { replyTo: "a" }),
    msg("note", "user", "设定", 4, { kind: "setting" }),
  ]);
  assert.deepEqual(history.map((m) => m.id), ["a", "ra"]);
  assert.equal(skipsQingran(msg("m1", "user", UNRECOGNIZED_TEXT, 1)), true);
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

test("dropIncompleteReplies keeps an interrupted empty assistant", () => {
  const next = dropIncompleteReplies([
    msg("u1", "user", "一"),
    msg("a1", "assistant", "", 2, { interrupted: true }),
  ]);
  assert.equal(next.length, 2);
  assert.equal(next[1]?.interrupted, true);
});

test("historyForQingran appends the interrupt mark to interrupted replies", () => {
  const history = historyForQingran([
    msg("u1", "user", "听我说", 1),
    msg("a1", "assistant", "我正要说完", 2, { interrupted: true }),
  ]);
  assert.deepEqual(history.map((m) => m.text), ["听我说", `我正要说完${INTERRUPTED_MARK}`]);
});

test("historyForQingran does not double the interrupt mark", () => {
  const history = historyForQingran([
    msg("a1", "assistant", `已经有了${INTERRUPTED_MARK}`, 1, { interrupted: true }),
  ]);
  assert.equal(history[0]?.text, `已经有了${INTERRUPTED_MARK}`);
});

test("sibling replies stay on one turn and the chosen page continues", () => {
  const messages = [
    msg("u1", "user", "在吗", 1, { activeReply: "a1" }),
    msg("a1", "assistant", "第一句", 2, { replyTo: "u1" }),
    msg("a2", "assistant", "第二句", 3, { replyTo: "u1" }),
  ];
  const pairs = pairMessages(messages);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.assistant?.id, "a1");
  assert.deepEqual(pairs[0]?.replies?.map((reply) => reply.id), ["a1", "a2"]);
  assert.deepEqual(historyForQingran(messages).map((m) => m.id), ["u1", "a1"]);
  assert.deepEqual(unselectedReplyIds(messages), ["a2"]);
});

test("without a chosen page, the newest reply continues and the rest are dropped later", () => {
  const messages = [
    msg("u1", "user", "在吗", 1),
    msg("a1", "assistant", "第一句", 2, { replyTo: "u1" }),
    msg("a2", "assistant", "第二句", 3, { replyTo: "u1" }),
  ];
  assert.equal(shownReply(messages[0], [messages[1]!, messages[2]!])?.id, "a2");
  assert.deepEqual(historyForQingran(messages).map((m) => m.id), ["u1", "a2"]);
  assert.deepEqual(unselectedReplyIds(messages), ["a1"]);
});

test("an empty chosen page does not discard the reply that has words", () => {
  const messages = [
    msg("u1", "user", "在吗", 1, { activeReply: "a2" }),
    msg("a1", "assistant", "第一句", 2, { replyTo: "u1" }),
    msg("a2", "assistant", "", 3, { replyTo: "u1" }),
  ];
  assert.equal(pairMessages(messages)[0]?.assistant?.id, "a2");
  assert.deepEqual(unselectedReplyIds(messages), ["a2"]);
  assert.deepEqual(historyForQingran(messages).map((m) => m.id), ["u1", "a1"]);
});

test("chosen reply marker round-trips and an edit keeps the prefixes", () => {
  const stored = encodeStoredMessage({
    id: "u1",
    role: "user",
    text: "在吗",
    createdAt: 1,
    activeReply: "a2",
    voiceTurnId: "turn-1",
  });
  assert.equal(decodeStoredBody(stored).activeReply, "a2");
  assert.equal(decodeStoredBody(stored).text, "在吗");
  assert.equal(mergeEditedUserBody(stored, "在吗"), stored);
  const edited = mergeEditedUserBody(stored, "过来");
  assert.equal(decodeStoredBody(edited).text, "过来");
  assert.equal(decodeStoredBody(edited).activeReply, "a2");
  assert.equal(decodeStoredBody(edited).voiceTurnId, "turn-1");
});

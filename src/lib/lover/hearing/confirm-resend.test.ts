import assert from "node:assert/strict";
import { test } from "node:test";
import { historyForQingran } from "../pair-messages.ts";
import type { ChatMessage } from "../types.ts";
import { UNRECOGNIZED_TEXT } from "./heard.ts";
import { planConfirmSave, shouldResendAfterConfirm } from "./confirm-resend.ts";

function chat(): ChatMessage[] {
  return [
    { id: "A", role: "user", text: "旧A", createdAt: 1 },
    { id: "a1", role: "assistant", text: "回A", createdAt: 2 },
    { id: "B", role: "user", text: "B", createdAt: 3 },
    { id: "b1", role: "assistant", text: "回B", createdAt: 4 },
  ];
}

test("[A, B] editing A does not resend; B and replies stay; later history uses the new text", () => {
  const messages = chat();
  const plan = planConfirmSave(messages, messages[0]!, { goldText: "新A", noiseOnly: false });
  assert.equal(plan.shouldResend, false);
  assert.deepEqual(plan.removed, []);
  assert.equal(plan.updated.text, "新A");
  assert.equal(plan.updated.kind, "say");
  const next = messages.map((m) => (m.id === "A" ? plan.updated : m));
  assert.deepEqual(
    next.map((m) => m.text),
    ["新A", "回A", "B", "回B"],
  );
  assert.deepEqual(
    historyForQingran(next).map((m) => m.text),
    ["新A", "回A", "B", "回B"],
  );
});

test("[A, B] editing B deletes B's reply and should regenerate", () => {
  const messages = chat();
  const plan = planConfirmSave(messages, messages[2]!, { goldText: "新B", noiseOnly: false });
  assert.equal(plan.shouldResend, true);
  assert.deepEqual(
    plan.removed.map((m) => m.id),
    ["b1"],
  );
  assert.equal(plan.updated.text, "新B");
});

test("correcting an earlier 〔未识别〕 does not resend but later history includes it", () => {
  const messages: ChatMessage[] = [
    { id: "A", role: "user", text: UNRECOGNIZED_TEXT, createdAt: 1, kind: "unheard" },
    { id: "B", role: "user", text: "B", createdAt: 2 },
    { id: "b1", role: "assistant", text: "回B", createdAt: 3 },
  ];
  const plan = planConfirmSave(messages, messages[0]!, { goldText: "其实是A", noiseOnly: false });
  assert.equal(plan.shouldResend, false);
  assert.equal(plan.updated.kind, "say");
  const next = [plan.updated, messages[1]!, messages[2]!];
  assert.deepEqual(
    historyForQingran(next).map((m) => m.text),
    ["其实是A", "B", "回B"],
  );
});

test("last 〔未识别〕 corrected resends as a normal turn", () => {
  const messages: ChatMessage[] = [{ id: "A", role: "user", text: UNRECOGNIZED_TEXT, createdAt: 1, kind: "unheard" }];
  const plan = planConfirmSave(messages, messages[0]!, { goldText: "我想你了", noiseOnly: false });
  assert.equal(plan.shouldResend, true);
  assert.equal(plan.updated.kind, "say");
});

test("noise-only confirm does not resend and stays out of history", () => {
  const messages = chat();
  assert.equal(
    planConfirmSave(messages, messages[2]!, { goldText: "新B", noiseOnly: true }).shouldResend,
    false,
  );
  const earlier = planConfirmSave(messages, messages[0]!, {
    goldText: "谢谢观看",
    noiseOnly: true,
  });
  assert.equal(earlier.shouldResend, false);
  assert.equal(earlier.updated.kind, "unheard");
  const next = messages.map((m) => (m.id === "A" ? earlier.updated : m));
  assert.deepEqual(
    historyForQingran(next).map((m) => m.id),
    ["a1", "B", "b1"],
  );
});

test("during B's regeneration, confirming A only updates gold and display", () => {
  const inflight: ChatMessage[] = [
    { id: "A", role: "user", text: "旧A", createdAt: 1 },
    { id: "a1", role: "assistant", text: "回A", createdAt: 2 },
    { id: "B", role: "user", text: "新B", createdAt: 3 },
    { id: "b2", role: "assistant", text: "", createdAt: 4 },
  ];
  const plan = planConfirmSave(inflight, inflight[0]!, { goldText: "改A", noiseOnly: false });
  assert.equal(plan.shouldResend, false);
  assert.equal(plan.updated.text, "改A");
  assert.deepEqual(plan.removed, []);
});

test("tag-only or empty gold does not resend", () => {
  assert.equal(
    shouldResendAfterConfirm({ goldText: "B", previousText: "B", noiseOnly: false, isLastUser: true }),
    false,
  );
  assert.equal(
    shouldResendAfterConfirm({ goldText: "  B  ", previousText: "B", noiseOnly: false, isLastUser: true }),
    false,
  );
  assert.equal(
    shouldResendAfterConfirm({ goldText: "", previousText: "B", noiseOnly: false, isLastUser: true }),
    false,
  );
  assert.equal(
    shouldResendAfterConfirm({ goldText: "新A", previousText: "旧A", noiseOnly: false, isLastUser: false }),
    false,
  );
});

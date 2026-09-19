import assert from "node:assert/strict";
import { test } from "node:test";
import { UNRECOGNIZED_TEXT } from "./heard.ts";
import { shouldResendAfterConfirm, sliceAfterMessage } from "./confirm-resend.ts";

test("editing text with later messages deletes them and should resend", () => {
  const messages = [
    { id: "u1", text: "在吗" },
    { id: "a1", text: "在的" },
    { id: "u2", text: "吃了吗" },
    { id: "a2", text: "吃过了" },
  ];
  const sliced = sliceAfterMessage(messages, "u1");
  assert.ok(sliced);
  assert.deepEqual(
    sliced.removed.map((m) => m.id),
    ["a1", "u2", "a2"],
  );
  assert.deepEqual(
    sliced.history.map((m) => m.id),
    [],
  );
  assert.equal(
    shouldResendAfterConfirm({ goldText: "在吗呀", previousText: "在吗", noiseOnly: false }),
    true,
  );
});

test("noise-only confirm does not resend", () => {
  assert.equal(
    shouldResendAfterConfirm({ goldText: "谢谢观看", previousText: UNRECOGNIZED_TEXT, noiseOnly: true }),
    false,
  );
  assert.equal(
    shouldResendAfterConfirm({ goldText: "在吗呀", previousText: "在吗", noiseOnly: true }),
    false,
  );
});

test("correcting 〔未识别〕 resends as a normal turn", () => {
  assert.equal(
    shouldResendAfterConfirm({ goldText: "我想你了", previousText: UNRECOGNIZED_TEXT, noiseOnly: false }),
    true,
  );
});

test("tag-only or ✓ confirm does not resend", () => {
  assert.equal(
    shouldResendAfterConfirm({ goldText: "在吗", previousText: "在吗", noiseOnly: false }),
    false,
  );
  assert.equal(
    shouldResendAfterConfirm({ goldText: "  在吗  ", previousText: "在吗", noiseOnly: false }),
    false,
  );
  assert.equal(
    shouldResendAfterConfirm({ goldText: "", previousText: "在吗", noiseOnly: false }),
    false,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatCallLogPlain,
  labelCallMessages,
  messagesFromStored,
} from "./call-log-view.ts";

test("labelCallMessages tags system, injected blocks, history, and the last user turn", () => {
  const labeled = labelCallMessages([
    { role: "system", content: "人设" },
    { role: "system", content: "长期" },
    { role: "user", content: "昨" },
    { role: "assistant", content: "嗯" },
    { role: "user", content: "今天呢" },
  ]);
  assert.deepEqual(
    labeled.map((row) => row.label),
    ["system", "注入块", "历史", "历史", "用户消息"],
  );
  const reflect = labelCallMessages([
    { role: "system", content: "s" },
    { role: "user", content: "B" },
    { role: "user", content: "C" },
  ]);
  assert.deepEqual(
    reflect.map((row) => row.label),
    ["system", "注入块", "用户消息"],
  );
});

test("messagesFromStored reads messages, system+user parts, and truncated preview", () => {
  assert.deepEqual(messagesFromStored({ messages: [{ role: "user", content: "hi" }] }), [
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(messagesFromStored({ system: "S", user: ["A", "B"] }), [
    { role: "system", content: "S" },
    { role: "user", content: "A" },
    { role: "user", content: "B" },
  ]);
  const clipped = messagesFromStored({ truncated: true, preview: "cut" });
  assert.equal(clipped?.[0]?.content, "cut");
  assert.equal(messagesFromStored(null), null);
});

test("formatCallLogPlain includes input and output sections", () => {
  const text = formatCallLogPlain({
    step: "voice:x",
    model: "m",
    effort: "low",
    ms: 12,
    messages: labelCallMessages([{ role: "system", content: "人设" }, { role: "user", content: "在吗" }]),
    output: "嗯",
  });
  assert.match(text, /—— 输入 ——/);
  assert.match(text, /—— 输出 ——/);
  assert.match(text, /【system · system】/);
  assert.match(text, /【用户消息 · user】/);
  assert.match(text, /\n嗯$/);
});

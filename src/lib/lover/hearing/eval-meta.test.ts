import assert from "node:assert/strict";
import { test } from "node:test";
import { hashQingranPrompt, lastContextTurns, promptHash12 } from "./eval-meta.ts";

test("prompt_hash is sha256 prefix of 12 hex chars", () => {
  const hash = promptHash12("hello");
  assert.equal(hash.length, 12);
  assert.match(hash, /^[0-9a-f]{12}$/);
  assert.equal(promptHash12("hello"), hash);
  assert.notEqual(promptHash12("hello"), promptHash12("hello!"));
});

test("qingran prompt hash changes when the system prompt changes", () => {
  const a = hashQingranPrompt("你就是清然。");
  const b = hashQingranPrompt("你就是别人。");
  assert.equal(a.length, 12);
  assert.notEqual(a, b);
});

test("context_before keeps the last 4 rounds", () => {
  const turns = lastContextTurns(
    [
      { role: "user", text: "1" },
      { role: "assistant", text: "2" },
      { role: "user", text: "3" },
      { role: "assistant", text: "4" },
      { role: "user", text: "5" },
      { role: "assistant", text: "6" },
      { role: "user", text: "7" },
      { role: "assistant", text: "8" },
      { role: "user", text: "9" },
      { role: "assistant", text: "10" },
    ],
    4,
  );
  assert.deepEqual(
    turns.map((t) => t.text),
    ["3", "4", "5", "6", "7", "8", "9", "10"],
  );
});

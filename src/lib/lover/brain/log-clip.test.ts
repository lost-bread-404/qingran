import assert from "node:assert/strict";
import { test } from "node:test";
import { clipLogJson, clipLogRecord, LOG_RECORD_LIMIT } from "./log-clip.ts";

test("clipLogRecord leaves small rows intact", () => {
  const out = clipLogRecord({ inputSystem: "sys", inputUser: "user", outputText: "out" });
  assert.equal(out.truncated, false);
  assert.equal(out.inputSystem, "sys");
  assert.equal(out.inputUser, "user");
  assert.equal(out.outputText, "out");
});

test("clipLogRecord trims a row over 200KB and marks it", () => {
  const huge = "x".repeat(LOG_RECORD_LIMIT);
  const out = clipLogRecord({
    inputSystem: "S".repeat(1000),
    inputUser: huge,
    outputText: "ok",
  });
  assert.equal(out.truncated, true);
  assert.match(out.inputUser ?? "", /\[truncated\]$/);
  assert.ok((out.inputSystem?.length ?? 0) + (out.inputUser?.length ?? 0) + (out.outputText?.length ?? 0) <= LOG_RECORD_LIMIT + 32);
  assert.equal(out.outputText, "ok");
});

test("clipLogJson keeps valid jsonb when over the cap", () => {
  const small = clipLogJson({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(small.truncated, false);
  assert.equal(JSON.parse(small.value).messages[0].content, "hi");
  const big = clipLogJson({ text: "y".repeat(LOG_RECORD_LIMIT) });
  assert.equal(big.truncated, true);
  const parsed = JSON.parse(big.value) as { truncated: boolean; preview: string };
  assert.equal(parsed.truncated, true);
  assert.match(parsed.preview, /\[truncated\]$/);
});

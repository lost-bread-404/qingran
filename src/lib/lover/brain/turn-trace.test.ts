import assert from "node:assert/strict";
import { test } from "node:test";
import { clipTraceValue, TRACE_FIELD_LIMIT } from "./turn-trace.ts";

test("trace fields over 100KB are truncated and marked", () => {
  const small = clipTraceValue({ ok: true });
  assert.equal(small.truncated, false);
  const big = "x".repeat(TRACE_FIELD_LIMIT + 50);
  const clipped = clipTraceValue(big);
  assert.equal(clipped.truncated, true);
  assert.equal(typeof clipped.value, "string");
  assert.match(String(clipped.value), /\[truncated\]$/);
  assert.ok(String(clipped.value).length < big.length);
});

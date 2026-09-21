import assert from "node:assert/strict";
import { test } from "node:test";
import { isXaiQuotaFail, QUOTA_HINT, xaiFailHint } from "./xai-error.ts";

test("402 is always out of credit", () => {
  assert.equal(isXaiQuotaFail(402, ""), true);
  assert.equal(xaiFailHint(402), QUOTA_HINT);
});

test("429 with insufficient_quota is out of credit", () => {
  const body = JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } });
  assert.equal(isXaiQuotaFail(429, body), true);
  assert.equal(xaiFailHint(429, body), QUOTA_HINT);
});

test("plain 429 is just too fast", () => {
  assert.equal(isXaiQuotaFail(429, ""), false);
  assert.equal(xaiFailHint(429), "说得太密了，等几秒再开口。");
});

test("other errors keep the status number", () => {
  assert.equal(xaiFailHint(500), "想你的时候卡住了（500）。");
  assert.equal(isXaiQuotaFail(500, "internal"), false);
});

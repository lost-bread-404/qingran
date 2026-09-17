import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_CLASSES } from "../config.ts";
import { estimateTokensFromChars, llmCostFromText, llmCostUsd, sttCostUsd, ttsCostUsd } from "./cost.ts";

test("cached tokens billed at cache rate, reasoning added to output", () => {
  const r = llmCostUsd("x-short", {
    tokensIn: 1000,
    tokensCached: 400,
    tokensOut: 100,
    tokensReasoning: 50,
  });
  assert.equal(r, null);
  const priced = llmCostUsd(MODEL_CLASSES.FAST_THINKER.model, {
    tokensIn: 100_000,
    tokensCached: 40_000,
    tokensOut: 10_000,
    tokensReasoning: 5_000,
  });
  assert.ok(priced);
  // uncached 60k * 1.25 + cached 40k * 0.20 + 15k * 2.50 = 0.075+0.008+0.0375
  assert.ok(Math.abs(priced!.usd - 0.1205) < 1e-9);
  assert.equal(priced!.estimated, false);
});

test("prompt at 200k doubles all token rates", () => {
  const model = MODEL_CLASSES.FAST_THINKER.model;
  const small = llmCostUsd(model, {
    tokensIn: 1_000,
    tokensCached: 0,
    tokensOut: 0,
    tokensReasoning: 0,
  });
  const big = llmCostUsd(model, {
    tokensIn: 200_000,
    tokensCached: 0,
    tokensOut: 0,
    tokensReasoning: 0,
  });
  assert.ok(small && big);
  assert.ok(Math.abs(small.usd - 0.00125) < 1e-9);
  assert.ok(Math.abs(big.usd - 0.5) < 1e-9);
});

test("missing usage falls back to char estimate", () => {
  const est = llmCostFromText(MODEL_CLASSES.FAST_THINKER.model, "你好世界", "嗯。");
  assert.equal(est.estimated, true);
  assert.ok(est.tokensIn >= 4);
  assert.ok(est.usd > 0);
});

test("tts and stt prices", () => {
  assert.equal(ttsCostUsd(1_000_000), 15);
  assert.equal(sttCostUsd(3600, false), 0.1);
  assert.equal(sttCostUsd(3600, true), 0.2);
});

test("cjk counts as one token, ascii ~4 chars", () => {
  assert.equal(estimateTokensFromChars("你好"), 2);
  assert.equal(estimateTokensFromChars("abcd"), 1);
});

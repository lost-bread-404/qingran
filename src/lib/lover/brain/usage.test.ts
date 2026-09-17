import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_CLASSES } from "./config.ts";
import { formatMindAge, parseUsage, settleLlmCost, TICKS_PER_USD } from "./usage.ts";

test("formatMindAge floors minutes hours days", () => {
  assert.equal(formatMindAge(29 * 60_000), "29 分钟");
  assert.equal(formatMindAge(30 * 60_000), "30 分钟");
  assert.equal(formatMindAge(31 * 60_000), "31 分钟");
  assert.equal(formatMindAge(59 * 60_000), "59 分钟");
  assert.equal(formatMindAge(61 * 60_000), "1 小时");
  assert.equal(formatMindAge(25 * 3_600_000), "1 天");
  assert.equal(formatMindAge(3 * 86_400_000), "3 天");
});

test("parseUsage reads cost_in_usd_ticks", () => {
  const u = parseUsage({
    input_tokens: 10,
    output_tokens: 4,
    cost_in_usd_ticks: TICKS_PER_USD,
  });
  assert.equal(u.costTicks, TICKS_PER_USD);
  assert.equal(u.tokensIn, 10);
});

test("settleLlmCost prefers ticks then price table then char estimate", () => {
  const model = MODEL_CLASSES.FAST_THINKER.model;
  const withTicks = settleLlmCost(
    model,
    { tokensIn: 1000, tokensCached: 0, tokensOut: 10, tokensReasoning: 0, costTicks: TICKS_PER_USD },
    "hi",
    "ok",
  );
  assert.equal(withTicks.source, "xai");
  assert.equal(withTicks.usd, 1);
  assert.ok(withTicks.usdEst != null && withTicks.usdEst < 1);

  const priced = settleLlmCost(
    model,
    { tokensIn: 1000, tokensCached: 0, tokensOut: 0, tokensReasoning: 0, costTicks: null },
    "hi",
    "ok",
  );
  assert.equal(priced.source, "price_table");
  assert.ok(priced.usd > 0);

  const est = settleLlmCost(
    "unknown-model",
    { tokensIn: null, tokensCached: null, tokensOut: null, tokensReasoning: null, costTicks: null },
    "你好世界",
    "嗯。",
  );
  assert.equal(est.source, "char_estimate");
  assert.equal(est.estimated, true);
});

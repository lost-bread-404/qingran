import assert from "node:assert/strict";
import { test } from "node:test";
import { DRAIN_BUDGET_MS, LONG_DRAIN_MS, ROUTES } from "./config.ts";
import { canStartJob, retryDelayMs } from "./jobs-policy.ts";

test("long jobs wait for remaining budget", () => {
  assert.equal(canStartJob("archive", 1_000), true);
  assert.equal(canStartJob("reflect", ROUTES.reflect.timeoutMs - 1), false);
  assert.equal(canStartJob("reflect", ROUTES.reflect.timeoutMs), true);
  assert.equal(canStartJob("synth", ROUTES.synth.timeoutMs - 1), false);
  assert.equal(canStartJob("synth", ROUTES.synth.timeoutMs), true);
  assert.equal(canStartJob("report", ROUTES.report.timeoutMs - 1), false);
  assert.equal(canStartJob("report", ROUTES.report.timeoutMs), true);
  assert.equal(canStartJob("dusk", 1_000), true);
});

test("LONG_DRAIN_MS after 1s can start synth/report/reflect; talk drain cannot", () => {
  assert.equal(canStartJob("synth", LONG_DRAIN_MS - 1_000), true);
  assert.equal(canStartJob("report", LONG_DRAIN_MS - 1_000), true);
  assert.equal(canStartJob("reflect", LONG_DRAIN_MS - 1_000), true);
  assert.equal(canStartJob("synth", DRAIN_BUDGET_MS), false);
  assert.equal(canStartJob("report", DRAIN_BUDGET_MS), false);
  assert.equal(canStartJob("reflect", DRAIN_BUDGET_MS), false);
});

test("retry delay is 30s exponential in attempts", () => {
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(2), 60_000);
  assert.equal(retryDelayMs(3), 120_000);
});

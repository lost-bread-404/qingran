import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTES } from "./config.ts";
import { canStartJob, retryDelayMs } from "./jobs-policy.ts";

test("long jobs wait for remaining budget", () => {
  assert.equal(canStartJob("reflect", 1_000), true);
  assert.equal(canStartJob("archive", 1_000), true);
  assert.equal(canStartJob("synth", ROUTES.synth.timeoutMs - 1), false);
  assert.equal(canStartJob("synth", ROUTES.synth.timeoutMs), true);
  assert.equal(canStartJob("report", ROUTES.report.timeoutMs - 1), false);
  assert.equal(canStartJob("report", ROUTES.report.timeoutMs), true);
  assert.equal(canStartJob("dusk", 1_000), true);
});

test("retry delay is 30s exponential in attempts", () => {
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(2), 60_000);
  assert.equal(retryDelayMs(3), 120_000);
});

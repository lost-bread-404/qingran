import assert from "node:assert/strict";
import { test } from "node:test";
import { isNoiseDisagreement, shouldDropAsNoise } from "./noise.ts";

test("drop noise only when provider and xai both empty", () => {
  assert.equal(shouldDropAsNoise(true, ""), true);
  assert.equal(shouldDropAsNoise(true, "   "), true);
  assert.equal(shouldDropAsNoise(true, "嗯"), false);
  assert.equal(shouldDropAsNoise(false, ""), false);
  assert.equal(shouldDropAsNoise(false, "今天好累"), false);
});

test("disagreement when adapter says noise but xai has speech", () => {
  assert.equal(isNoiseDisagreement(true, "嗯"), true);
  assert.equal(isNoiseDisagreement(true, ""), false);
  assert.equal(isNoiseDisagreement(false, "嗯"), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { goldTierFor, inEvalSet } from "./gold.ts";

test("gold tiers: text 1, emotion 2, cues 3", () => {
  assert.equal(goldTierFor({ source: "confirmed" }), 1);
  assert.equal(goldTierFor({ source: "edited", emotionSet: true }), 2);
  assert.equal(goldTierFor({ source: "edited", emotionSet: true, hasCues: true }), 3);
  assert.equal(goldTierFor({}), 0);
  assert.equal(inEvalSet("confirmed"), true);
  assert.equal(inEvalSet("edited"), true);
  assert.equal(inEvalSet(null), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyConfusions,
  confusionId,
  extractConfusionPairs,
  isActiveConfusion,
} from "./confusions.ts";

test("extractConfusionPairs pulls character substitutions from edited gold", () => {
  const pairs = extractConfusionPairs("青然在嘛", "清然在吗");
  assert.deepEqual(pairs, [
    { wrong: "青", correct: "清" },
    { wrong: "嘛", correct: "吗" },
  ]);
  assert.equal(confusionId("青", "清"), "青→清");
});

test("extractConfusionPairs groups consecutive mismatches", () => {
  const pairs = extractConfusionPairs("邻宅", "林泽");
  assert.deepEqual(pairs, [{ wrong: "邻宅", correct: "林泽" }]);
});

test("applyConfusions only uses rules seen at least twice", () => {
  const once = applyConfusions("青然在嘛", [
    { wrong: "青", correct: "清", count: 1, enabled: true },
    { wrong: "嘛", correct: "吗", count: 2, enabled: true },
  ]);
  assert.equal(once.text, "青然在吗");
  assert.deepEqual(once.replacements, [{ wrong: "嘛", correct: "吗" }]);

  const disabled = applyConfusions("青然在嘛", [
    { wrong: "青", correct: "清", count: 4, enabled: false },
    { wrong: "嘛", correct: "吗", count: 2, enabled: true },
  ]);
  assert.equal(disabled.text, "青然在吗");
  assert.equal(isActiveConfusion({ count: 2, enabled: true }), true);
  assert.equal(isActiveConfusion({ count: 4, enabled: false }), false);
});

test("applyConfusions prefers longer wrong spans and stays bounded", () => {
  const out = applyConfusions("小猫小猫", [
    { wrong: "小猫", correct: "Rosie", count: 3, enabled: true },
    { wrong: "小", correct: "少", count: 3, enabled: true },
  ]);
  assert.equal(out.text, "RosieRosie");
  assert.deepEqual(out.replacements, [{ wrong: "小猫", correct: "Rosie" }]);
});

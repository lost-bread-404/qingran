import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAltTags, clipAlternatives } from "./nbest.ts";

test("clip alternatives to two spans and two candidates", () => {
  const alts = clipAlternatives([
    { span: "天", candidates: ["天", "填", "田"] },
    { span: "累", candidates: ["累"] },
    { span: "好", candidates: ["好", "号"] },
    { span: "再", candidates: ["再", "在"] },
  ]);
  assert.equal(alts.length, 2);
  assert.deepEqual(alts[0]?.candidates, ["天", "填"]);
  assert.equal(applyAltTags("今天好累", alts), "今{天|填}{好|号}累");
});

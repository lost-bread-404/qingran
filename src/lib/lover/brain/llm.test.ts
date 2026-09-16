import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJson } from "./text.ts";

test("extractJson handles fences, wrappers, and arrays", () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}');
  assert.equal(extractJson("```json\n{\"a\":1}\n```"), '{"a":1}');
  assert.equal(extractJson('noise {"a":1} tail'), '{"a":1}');
  assert.equal(extractJson("[1,2]"), "[1,2]");
  assert.equal(extractJson("not json"), "not json");
});

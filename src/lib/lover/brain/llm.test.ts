import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { classifyReflectFailure, finishReasonFromApi, type CallModelResult } from "./llm.ts";
import { extractJson } from "./text.ts";

test("extractJson handles fences, wrappers, and arrays", () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}');
  assert.equal(extractJson("```json\n{\"a\":1}\n```"), '{"a":1}');
  assert.equal(extractJson('noise {"a":1} tail'), '{"a":1}');
  assert.equal(extractJson("[1,2]"), "[1,2]");
  assert.equal(extractJson("not json"), "not json");
});

test("classifyReflectFailure splits timeout, http_error, parse_error", () => {
  const base: CallModelResult = {
    ok: false,
    text: "",
    json: null,
    toolCalls: [],
    raw: null,
    model: "x",
    effort: "low",
    ms: 1,
  };
  assert.equal(classifyReflectFailure({ ...base, failKind: "timeout" }), "timeout");
  assert.equal(
    classifyReflectFailure({
      ...base,
      failKind: "http_error",
      httpStatus: 502,
      responseSnippet: "bad gateway body",
    }),
    "http_error 502 bad gateway body",
  );
  assert.equal(classifyReflectFailure({ ...base, failKind: "parse_error" }), "parse_error");
  assert.equal(classifyReflectFailure(base), "parse_error");
});

test("finishReasonFromApi reads chat, responses status, and incomplete reason", () => {
  assert.equal(finishReasonFromApi({ choices: [{ finish_reason: "stop" }] }), "stop");
  assert.equal(finishReasonFromApi({ status: "completed" }), "completed");
  assert.equal(finishReasonFromApi({ incomplete_details: { reason: "max_output_tokens" } }), "max_output_tokens");
  assert.equal(finishReasonFromApi(null), null);
});

test("callModel always stores input and output text", () => {
  const src = readFileSync(new URL("./llm.ts", import.meta.url), "utf8");
  assert.match(src, /inputSystem: input.system/);
  assert.match(src, /outputText: text/);
  assert.doesNotMatch(src, /skipOutput/);
  assert.doesNotMatch(src, /HIGH_FREQ_ROUTES/);
});

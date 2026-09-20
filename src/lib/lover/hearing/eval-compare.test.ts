import assert from "node:assert/strict";
import { test } from "node:test";
import { cer, percentile } from "./metrics.ts";
import {
  EVAL_BATCH_SIZE,
  emptyEngineEval,
  evalBatchWindow,
  evalJobs,
  scoreEngineEval,
  scoreEngineEvalByEngine,
  statusFromFailReason,
  statusFromXaiError,
} from "./eval-compare.ts";

test("eval jobs flatten clip × engine and batches of 10 report progress", () => {
  assert.equal(EVAL_BATCH_SIZE, 10);
  const jobs = evalJobs(["a", "b", "c"], ["xai", "gemini"]);
  assert.equal(jobs.length, 6);
  assert.deepEqual(jobs[0], { clipId: "a", engine: "xai" });
  assert.deepEqual(jobs[1], { clipId: "a", engine: "gemini" });

  const first = evalBatchWindow({ total: 25, offset: 0 });
  assert.deepEqual(first, { start: 0, end: 10, count: 10, nextOffset: 10, done: false, total: 25 });
  const second = evalBatchWindow({ total: 25, offset: first.nextOffset });
  assert.deepEqual(second, { start: 10, end: 20, count: 10, nextOffset: 20, done: false, total: 25 });
  const last = evalBatchWindow({ total: 25, offset: second.nextOffset });
  assert.deepEqual(last, { start: 20, end: 25, count: 5, nextOffset: 25, done: true, total: 25 });
  assert.equal(evalBatchWindow({ total: 0, offset: 0 }).done, true);
  assert.equal(evalBatchWindow({ total: 6, offset: 0 }).done, true);
});

test("fail reasons map to hard/soft refusal, timeout, and error", () => {
  assert.equal(statusFromFailReason("timeout"), "timeout");
  assert.equal(statusFromFailReason("refusal"), "hard_refusal");
  assert.equal(statusFromFailReason("schema"), "soft_refusal");
  assert.equal(statusFromFailReason("http"), "error");
  assert.equal(statusFromFailReason("missing_key"), "error");
  assert.equal(statusFromXaiError("TimeoutError"), "timeout");
  assert.equal(statusFromXaiError("the operation was aborted"), "timeout");
  assert.equal(statusFromXaiError("没听清（429）。"), "error");
});

test("engine eval scores CER, exact match, refusals, tags, and latency percentiles", () => {
  const scored = scoreEngineEval([
    {
      engine: "gemini",
      text: "在吗",
      status: "ok",
      goldText: "在吗",
      tags: { length: "short", contour: "flat" },
      goldTags: { length: "short", contour: "rising" },
      tagsTouched: ["length", "contour"],
      latencyMs: 10,
    },
    {
      engine: "gemini",
      text: "我喜欢你",
      status: "ok",
      goldText: "嗯",
      tags: { length: "short", contour: "flat", events: ["laugh"] },
      goldTags: { events: ["laugh"] },
      tagsTouched: ["events"],
      latencyMs: 20,
    },
    {
      engine: "gemini",
      text: "",
      status: "hard_refusal",
      goldText: "啊",
      latencyMs: 30,
    },
    {
      engine: "gemini",
      text: "",
      status: "soft_refusal",
      goldText: "啊",
      latencyMs: 40,
    },
    {
      engine: "gemini",
      text: "",
      status: "timeout",
      goldText: "啊",
      latencyMs: 50,
    },
    {
      engine: "gemini",
      text: "",
      status: "error",
      goldText: "啊",
      latencyMs: 60,
    },
    {
      engine: "gemini",
      text: "谢谢观看",
      status: "ok",
      goldText: "",
      latencyMs: 70,
    },
  ]);
  assert.equal(scored.n, 7);
  assert.equal(scored.okN, 3);
  assert.equal(scored.refusals.hard_refusal, 1);
  assert.equal(scored.refusals.soft_refusal, 1);
  assert.equal(scored.refusals.timeout, 1);
  assert.equal(scored.refusals.error, 1);
  assert.equal(scored.exactMatch, 1 / 3);
  assert.equal(scored.cer, (0 + cer("嗯", "我喜欢你") + 1) / 3);
  assert.equal(scored.tagAccuracy.length, 1);
  assert.equal(scored.tagAccuracy.contour, 0);
  assert.equal(scored.tagAccuracy.events.laugh.precision, 1);
  assert.equal(scored.tagAccuracy.events.laugh.recall, 1);
  assert.equal(scored.latencyP50, percentile([10, 20, 30, 40, 50, 60, 70], 50));
  assert.equal(scored.latencyP95, percentile([10, 20, 30, 40, 50, 60, 70], 95));
});

test("eval by engine keeps empty engines and does not mix rows", () => {
  const scores = scoreEngineEvalByEngine(
    [
      { engine: "xai", text: "嗯", status: "ok", goldText: "嗯", latencyMs: 12 },
      { engine: "gemini", text: "", status: "timeout", goldText: "嗯", latencyMs: 8000 },
    ],
    ["gemini", "xai", "qwen"],
  );
  assert.deepEqual(
    scores.map((row) => row.engine),
    ["gemini", "xai", "qwen"],
  );
  assert.equal(scores[0]?.refusals.timeout, 1);
  assert.equal(scores[1]?.exactMatch, 1);
  assert.deepEqual(scores[2], emptyEngineEval("qwen"));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  TALK_FAIL,
  classifyTalkException,
  describeNonTextTalkEvent,
  isRetryableEmptyTalk,
  takeTalkDelta,
  talkFailFromResult,
} from "./talk-fail.ts";
import { xaiFailHint } from "./xai-error.ts";

test("timeout exception becomes 她想太久了，超时了", () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  const outcome = talkFailFromResult({ kind: "exception", threw: timeout, ms: 28010 });
  assert.equal(outcome.message, TALK_FAIL.timeout);
  assert.equal(outcome.message, "她想太久了，超时了");
  assert.equal(outcome.log.exceptionKind, "timeout");
  assert.equal(outcome.log.errorName, "TimeoutError");
  assert.match(outcome.log.errorMessage ?? "", /timeout/i);
  assert.equal(classifyTalkException(timeout).kind, "timeout");
});

test("empty 200 reply becomes 她没说出话（空回复）", () => {
  const outcome = talkFailFromResult({
    kind: "ok",
    status: 200,
    finishReason: "stop",
    speech: "   ",
    ms: 420,
  });
  assert.equal(outcome.message, "她没说出话（空回复）");
  assert.equal(outcome.log.status, 200);
  assert.equal(outcome.log.finishReason, "stop");
  assert.equal(outcome.log.chars, 0);
});

test("content_filter is reported with finish_reason", () => {
  const outcome = talkFailFromResult({
    kind: "ok",
    status: 200,
    finishReason: "content_filter",
    speech: "",
    ms: 210,
  });
  assert.equal(outcome.message, "这一轮被 xAI 拦下了（finish_reason=content_filter）");
  assert.equal(outcome.log.finishReason, "content_filter");
});

test("HTTP 500 keeps the original status hint", () => {
  const outcome = talkFailFromResult({ kind: "http", status: 500, body: "internal", ms: 90 });
  assert.equal(outcome.message, xaiFailHint(500, "internal"));
  assert.equal(outcome.message, "想你的时候卡住了（500）。");
  assert.equal(outcome.log.status, 500);
});

test("stop and length with text are not failures", () => {
  assert.equal(
    talkFailFromResult({ kind: "ok", status: 200, finishReason: "stop", speech: "在的", ms: 12 }).message,
    null,
  );
  assert.equal(
    talkFailFromResult({ kind: "ok", status: 200, finishReason: "length", speech: "还没说完", ms: 12 }).message,
    null,
  );
});

test("network errors stay 线路有点不稳", () => {
  const err = new TypeError("Failed to fetch");
  const outcome = talkFailFromResult({ kind: "exception", threw: err, ms: 30 });
  assert.equal(outcome.message, "线路有点不稳");
  assert.equal(outcome.log.exceptionKind, "network");
});

test("takeTalkDelta reads token and finish_reason from SSE json", () => {
  assert.deepEqual(takeTalkDelta({ choices: [{ delta: { content: "嗯" }, finish_reason: null }] }), {
    token: "嗯",
    finishReason: null,
  });
  assert.deepEqual(takeTalkDelta({ choices: [{ delta: {}, finish_reason: "content_filter" }] }), {
    token: "",
    finishReason: "content_filter",
  });
});

test("stream-talk logs each turn and maps timeout, empty, filter, HTTP, TTS", () => {
  const src = readFileSync(new URL("./stream-talk.ts", import.meta.url), "utf8");
  assert.match(src, /AbortSignal\.timeout\(28_000\)/);
  assert.match(src, /talkFailFromResult/);
  assert.match(src, /logTalkTurn/);
  assert.match(src, /takeTalkDelta/);
  assert.match(src, /TALK_FAIL\.tts/);
  assert.match(src, /tts: ttsOnly \|\| undefined/);
  assert.match(src, /failOnEmpty/);
  assert.match(src, /describeNonTextTalkEvent/);
  assert.match(src, /isRetryableEmptyTalk/);
  const api = readFileSync(new URL("../../routes/api/talk.ts", import.meta.url), "utf8");
  assert.match(api, /talkFailFromResult/);
  assert.match(api, /logTalkTurn/);
  assert.match(api, /runVoiceWithFallback/);
  assert.match(api, /formatVoiceLogNote/);
  assert.doesNotMatch(api, /线路有点不稳，稍后再说/);
});

test("describeNonTextTalkEvent skips text and usage-only chunks", () => {
  assert.equal(describeNonTextTalkEvent({ choices: [{ delta: { content: "嗯" } }] }), null);
  assert.equal(
    describeNonTextTalkEvent({
      id: "c",
      object: "chat.completion.chunk",
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    }),
    null,
  );
  const role = describeNonTextTalkEvent({
    choices: [{ delta: { role: "assistant" }, finish_reason: null }],
  });
  assert.match(role ?? "", /assistant/);
  const stop = describeNonTextTalkEvent({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 0 },
  });
  assert.match(stop ?? "", /finish_reason":"stop"/);
  assert.doesNotMatch(stop ?? "", /prompt_tokens/);
});

test("isRetryableEmptyTalk only for 200 empty stop/length/null", () => {
  assert.equal(isRetryableEmptyTalk({ status: 200, finishReason: "stop", speech: "" }), true);
  assert.equal(isRetryableEmptyTalk({ status: 200, finishReason: null, speech: "" }), true);
  assert.equal(isRetryableEmptyTalk({ status: 200, finishReason: "length", speech: "  " }), true);
  assert.equal(isRetryableEmptyTalk({ status: 200, finishReason: "content_filter", speech: "" }), false);
  assert.equal(isRetryableEmptyTalk({ status: 500, finishReason: "stop", speech: "" }), false);
  assert.equal(isRetryableEmptyTalk({ status: null, finishReason: null, speech: "" }), false);
  assert.equal(isRetryableEmptyTalk({ status: 200, finishReason: "stop", speech: "在" }), false);
});


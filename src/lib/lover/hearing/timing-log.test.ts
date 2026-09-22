import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatHearingLogNote,
  formatHearingTimingSummary,
  parseHearingTimingLine,
} from "./timing-format.ts";
import { slowEngineHint } from "./select.ts";

test("hearing log note records four segments and a slow-engine hint", () => {
  assert.equal(slowEngineHint("xai"), "");
  assert.equal(slowEngineHint("qwen"), "当前引擎：qwen（会拖慢识别）");
  assert.equal(slowEngineHint("gemini"), "当前引擎：gemini（会拖慢识别）");
  const note = formatHearingLogNote({
    silenceMs: 1480,
    uploadMs: 90,
    sttMs: 410,
    correctMs: 2,
    engineRequested: "qwen",
    engineUsed: "xai",
  });
  assert.match(note, /当前引擎：qwen（会拖慢识别）/);
  assert.match(note, /静音等待 1480ms · 上传 90ms · STT 410ms · 纠错 2ms/);
  assert.match(note, /engine=xai/);
  const parsed = parseHearingTimingLine(note);
  assert.deepEqual(parsed, { silenceMs: 1480, uploadMs: 90, sttMs: 410, correctMs: 2 });
  assert.equal(formatHearingTimingSummary(parsed!), "静音 1480ms · 上传 90ms · STT 410ms · 纠错 2ms");
});

test("missing segments render as dashes and still parse", () => {
  const note = formatHearingLogNote({
    silenceMs: null,
    uploadMs: 12,
    engineRequested: "xai",
    engineUsed: "xai",
  });
  assert.doesNotMatch(note, /当前引擎/);
  assert.match(note, /静音等待 — · 上传 12ms · STT — · 纠错 —/);
  assert.deepEqual(parseHearingTimingLine(note), {
    silenceMs: null,
    uploadMs: 12,
    sttMs: null,
    correctMs: null,
  });
  assert.equal(parseHearingTimingLine("no timing here"), null);
});

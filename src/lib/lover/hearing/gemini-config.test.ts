import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_HEARING_TIMEOUT_MS } from "./config.ts";

test("Gemini 3.8 Flash generationConfig omits temperature and keeps thinkingLevel low", () => {
  const src = readFileSync(new URL("./http.ts", import.meta.url), "utf8");
  const gemini = src.slice(src.indexOf("export async function hearWithGemini"), src.indexOf("export async function hearWithSelfhost"));
  assert.doesNotMatch(gemini, /temperature/);
  assert.doesNotMatch(gemini, /topP|top_p|topK|top_k|candidateCount|candidate_count/);
  assert.match(gemini, /thinkingLevel:\s*["']low["']/);
  assert.match(gemini, /status:\s*res\.status/);
});

test("Qwen Omni always streams and never retries without stream", () => {
  const src = readFileSync(new URL("./http.ts", import.meta.url), "utf8");
  const qwen = src.slice(src.indexOf("export async function hearWithQwen"), src.indexOf("export async function hearWithGemini"));
  assert.match(qwen, /preferStream:\s*true/);
  assert.match(qwen, /requireStream:\s*true/);
  assert.match(qwen, /omitTemperature:\s*true/);
  assert.match(qwen, /stream_options:\s*\{\s*include_usage:\s*true\s*\}/);
  assert.doesNotMatch(qwen, /temperature/);
  const chat = src.slice(src.indexOf("async function openaiAudioChat"));
  assert.match(chat, /const canFlipStream = !input\.requireStream/);
  assert.match(chat, /input\.omitTemperature/);
});

test("audio-LLM timeout defaults to 8s and is configurable", () => {
  assert.equal(DEFAULT_HEARING_TIMEOUT_MS, 8000);
  const config = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
  assert.match(config, /HEARING_TIMEOUT_MS/);
  assert.match(config, /hearingTimeoutMs/);
  const http = readFileSync(new URL("./http.ts", import.meta.url), "utf8");
  assert.match(http, /hearingTimeoutMs\(\)/);
});

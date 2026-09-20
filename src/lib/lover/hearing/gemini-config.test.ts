import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_HEARING_TIMEOUT_MS } from "./config.ts";

test("Gemini 3.8 Flash generationConfig omits temperature and keeps thinkingLevel low", () => {
  const src = readFileSync(new URL("./http.ts", import.meta.url), "utf8");
  const gemini = src.slice(src.indexOf("export async function hearWithGemini"), src.indexOf("export async function hearWithSelfhost"));
  assert.doesNotMatch(gemini, /temperature/);
  assert.match(gemini, /thinkingLevel:\s*["']low["']/);
  assert.match(gemini, /status:\s*res\.status/);
});

test("audio-LLM timeout defaults to 8s and is configurable", () => {
  assert.equal(DEFAULT_HEARING_TIMEOUT_MS, 8000);
  const config = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
  assert.match(config, /HEARING_TIMEOUT_MS/);
  assert.match(config, /hearingTimeoutMs/);
  const http = readFileSync(new URL("./http.ts", import.meta.url), "utf8");
  assert.match(http, /hearingTimeoutMs\(\)/);
});

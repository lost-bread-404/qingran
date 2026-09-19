import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Gemini 3.8 Flash generationConfig omits temperature and keeps thinkingLevel low", () => {
  const src = readFileSync(new URL("./http.ts", import.meta.url), "utf8");
  const gemini = src.slice(src.indexOf("export async function hearWithGemini"), src.indexOf("export async function hearWithSelfhost"));
  assert.doesNotMatch(gemini, /temperature/);
  assert.match(gemini, /thinkingLevel:\s*["']low["']/);
});

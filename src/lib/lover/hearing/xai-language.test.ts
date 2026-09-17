import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("xAI STT omits language so the API auto-detects", () => {
  const src = readFileSync(new URL("./xai.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /append\(\s*["']language["']/);
  assert.match(src, /append\(\s*["']keyterm["']/);
  assert.match(src, /filler_words/);
});

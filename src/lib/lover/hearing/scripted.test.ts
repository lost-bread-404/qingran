import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clipSaveBanner } from "./heard.ts";
import {
  bumpScriptedCount,
  countsFromQuotaRows,
  effectiveQuota,
  nextScriptedCategory,
  sanitizeSkipped,
} from "./scripted.ts";
import { SCRIPTED_CATEGORIES } from "./config.ts";

test("storage failure banner keeps the original error", () => {
  assert.equal(clipSaveBanner("column stt_text does not exist"), "录音没存上：column stt_text does not exist");
});

test("counts come from quota rows, not messages.length", () => {
  const counts = countsFromQuotaRows([
    { id: "en", have: 3 },
    { id: "ah", have: 0 },
  ]);
  assert.equal(counts.en, 3);
  assert.equal(bumpScriptedCount(counts, "en").en, 4);
});

test("skip sets effective quota to 0 and can be restored", () => {
  const en = SCRIPTED_CATEGORIES[0];
  assert.equal(effectiveQuota(en, ["en"]), 0);
  assert.equal(effectiveQuota(en, []), en.quota);
  const next = nextScriptedCategory({ en: 0 }, ["en"]);
  assert.ok(next && next.id !== "en");
  assert.deepEqual(sanitizeSkipped(["en", "nope", "en"]), ["en"]);
});

test("record page stores clips without calling STT or LLM APIs", () => {
  const src = readFileSync(new URL("../../../routes/record.tsx", import.meta.url), "utf8");
  assert.match(src, /saveHearingClip/);
  assert.doesNotMatch(src, /runHearing/);
  assert.doesNotMatch(src, /transcribeWithXai/);
  assert.doesNotMatch(src, /hearUtterance/);
  assert.doesNotMatch(src, /streamTalk/);
});

test("settings hearing tab is engine + debug + record + lab, n-best collapsed", () => {
  const src = readFileSync(new URL("../../../components/lover/settings-drawer.tsx", import.meta.url), "utf8");
  assert.match(src, />调试</);
  assert.doesNotMatch(src, /调试模式/);
  assert.doesNotMatch(src, /录音采集/);
  assert.match(src, /to="\/record"/);
  assert.match(src, />高级</);
  assert.match(src, /hearingNbest/);
});

test("transcript pencil opens confirm in debug; bubble text is not a hidden confirm entry", () => {
  const src = readFileSync(new URL("../../../components/lover/transcript.tsx", import.meta.url), "utf8");
  assert.match(src, /canConfirm \? onConfirmStart/);
  assert.doesNotMatch(src, /if \(canConfirm\) onConfirmStart/);
});

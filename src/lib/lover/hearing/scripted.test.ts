import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bumpScriptedCount,
  clipSaveBanner,
  countsFromQuotaRows,
  effectiveQuota,
  formatUnknownError,
  hearingSaveError,
  nextScriptedCategory,
  persistHearingClip,
  shouldForwardToQingran,
  shouldSaveEmptyTranscript,
  shouldShowUnheardHint,
} from "./scripted.ts";

test("insertClip failure is returned as saveError", () => {
  const err = Object.assign(new Error('column "stt_text" of relation "qingran_hearing_clips" does not exist'), {
    code: "42703",
    table: "qingran_hearing_clips",
    column: "stt_text",
  });
  const saveError = hearingSaveError(err);
  assert.match(saveError, /stt_text/);
  assert.match(saveError, /42703/);
  assert.equal(clipSaveBanner(saveError), `录音没存上：${saveError}`);
  assert.match(formatUnknownError("boom"), /boom/);
});

test("scripted capture stores empty transcripts and does not forward to chat", () => {
  assert.equal(persistHearingClip({ scripted: true, capture: false, debugHearing: false }), true);
  assert.equal(shouldSaveEmptyTranscript("scripted"), true);
  assert.equal(shouldSaveEmptyTranscript("real"), false);
  assert.equal(shouldForwardToQingran(true), false);
  assert.equal(shouldForwardToQingran(false), true);
  assert.equal(shouldShowUnheardHint(true, ""), false);
  assert.equal(shouldShowUnheardHint(false, ""), true);
  assert.equal(shouldShowUnheardHint(false, "嗯"), false);
});

test("scripted quota refresh uses clip counts, not messages.length", () => {
  const messagesLength = 0;
  const fromServer = countsFromQuotaRows([
    { id: "en", have: 1 },
    { id: "ah", have: 0 },
    { id: "noise", have: 0 },
  ]);
  assert.equal(fromServer.en, 1);
  const afterClip = bumpScriptedCount(fromServer, "en");
  assert.equal(afterClip.en, 2);
  assert.equal(nextScriptedCategory(afterClip)?.id, "en");
  assert.equal(messagesLength, 0);
  assert.notEqual(Object.keys(afterClip).sort().join(), "messages.length");

  const skipped = nextScriptedCategory({ en: 0, ah: 0 }, ["en"]);
  assert.equal(skipped?.id, "ah");
  assert.equal(effectiveQuota({ id: "en", quota: 12 }, ["en"]), 0);
  assert.equal(effectiveQuota({ id: "en", quota: 12 }, []), 12);
  assert.equal(nextScriptedCategory({ en: 12, ah: 12 }, [])?.id, "breathy");
});

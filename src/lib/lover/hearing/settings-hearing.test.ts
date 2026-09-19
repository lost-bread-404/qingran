import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clipSaveBanner } from "./heard.ts";

test("storage failure banner keeps the original error", () => {
  assert.equal(clipSaveBanner("column stt_text does not exist"), "录音没存上：column stt_text does not exist");
});

test("settings hearing tab is engine plus 标注模式 only", () => {
  const src = readFileSync(new URL("../../../components/lover/settings-drawer.tsx", import.meta.url), "utf8");
  assert.match(src, />标注模式</);
  assert.doesNotMatch(src, />调试</);
  assert.doesNotMatch(src, /调试模式/);
  assert.doesNotMatch(src, /录音采集/);
  assert.doesNotMatch(src, /to="\/record"/);
  assert.doesNotMatch(src, /定向录制/);
  assert.doesNotMatch(src, />高级</);
  assert.doesNotMatch(src, /hearingNbest/);
  assert.doesNotMatch(src, /to="\/lab"/);
});

test("transcript pencil opens confirm in debug; bubble text is not a hidden confirm entry", () => {
  const src = readFileSync(new URL("../../../components/lover/transcript.tsx", import.meta.url), "utf8");
  assert.match(src, /canConfirm \? onConfirmStart/);
  assert.doesNotMatch(src, /if \(canConfirm\) onConfirmStart/);
});

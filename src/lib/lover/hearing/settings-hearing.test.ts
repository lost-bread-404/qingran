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
  assert.match(src, /onConfirmQuick/);
  assert.match(src, /aria-label="确认正确"/);
  assert.match(src, /aria-label="打开标注"/);
  assert.match(src, /aria-label="改这句话"/);
  assert.match(src, /canConfirm \? \(/);
  assert.doesNotMatch(src, /if \(canConfirm\) onConfirmStart/);
});

test("confirm panel uses exclusive emotion chips including 噪音", () => {
  const src = readFileSync(new URL("../../../components/lover/confirm-turn.tsx", import.meta.url), "utf8");
  assert.match(src, /label: "噪音"/);
  assert.match(src, /撒娇/);
  assert.doesNotMatch(src, /这是纯噪音/);
  assert.doesNotMatch(src, /type="checkbox"/);
});

test("voice room shows labeled count, volume meter, and writes final_text back", () => {
  const src = readFileSync(new URL("../../../components/lover/voice-room.tsx", import.meta.url), "utf8");
  assert.match(src, /已标 \$\{labeledCount\} \/ 200/);
  assert.match(src, /VolumeMeter/);
  assert.match(src, /patchHearingFinalText/);
  assert.match(src, /saveConfirmQuick/);
  assert.match(src, /aria-label="阈值"/);
});

test("call and hold-to-talk pass peak_rms and trigger floor into hearUtterance", () => {
  const call = readFileSync(new URL("../../../hooks/use-call.ts", import.meta.url), "utf8");
  const hold = readFileSync(new URL("../../../hooks/use-voice-input.ts", import.meta.url), "utf8");
  assert.match(call, /peakRms:/);
  assert.match(call, /vadFloor: triggerFloorRef/);
  assert.match(call, /startThreshold/);
  assert.match(hold, /vadFloor: triggerFloorRef/);
  assert.match(hold, /holdThreshold/);
});

test("lab page is score card, worst 20, and hash export only", () => {
  const src = readFileSync(new URL("../../../routes/lab.tsx", import.meta.url), "utf8");
  assert.match(src, /最近 7 天/);
  assert.match(src, /CER 最终文字/);
  assert.match(src, /最差 20 条/);
  assert.match(src, /导出 JSON/);
  assert.match(src, /hash 80\/20/);
  assert.doesNotMatch(src, /重标/);
  assert.doesNotMatch(src, /disagreement/);
  assert.doesNotMatch(src, /覆盖率/);
  assert.doesNotMatch(src, /分配 dev\/test/);
});

test("runHearing persists with waitUntil; xai skips audio-LLM and a second STT", () => {
  const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  const hear = readFileSync(new URL("../hear.ts", import.meta.url), "utf8");
  assert.match(store, /from "@vercel\/functions"/);
  assert.match(store, /waitUntil\(/);
  assert.match(store, /provider === "xai" \? Promise.resolve\(null\)/);
  assert.match(store, /prefer_apple_quiet/);
  assert.match(hear, /ranHearing \|\| provider === "xai"/);
  assert.match(hear, /transcribeVoice/);
});

test("playback START_SEC is restored to pre-low-latency 0.42", () => {
  const src = readFileSync(new URL("../playback.ts", import.meta.url), "utf8");
  assert.match(src, /const START_SEC = 0\.42/);
  assert.match(src, /5cbea61/);
  assert.match(src, /pre-low-latency/);
});

test("debug transcript shows segmented latency", () => {
  const src = readFileSync(new URL("../../../components/lover/transcript.tsx", import.meta.url), "utf8");
  assert.match(src, /说完→识别完/);
  assert.match(src, /识别完→字/);
  assert.match(src, /→出声/);
});

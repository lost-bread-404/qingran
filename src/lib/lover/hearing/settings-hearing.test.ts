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
  assert.match(src, /打开标注页/);
  assert.match(src, /to="\/lab"/);
  assert.doesNotMatch(src, /定向录制/);
  assert.doesNotMatch(src, />高级</);
  assert.doesNotMatch(src, /hearingNbest/);
});

test("transcript pencil opens confirm in debug; bubble text is not a hidden confirm entry", () => {
  const src = readFileSync(new URL("../../../components/lover/transcript.tsx", import.meta.url), "utf8");
  assert.match(src, /onConfirmQuick/);
  assert.match(src, /aria-label="确认正确"/);
  assert.match(src, /aria-label="打开标注"/);
  assert.match(src, /aria-label="撤销标注"/);
  assert.match(src, /undoConfirmId/);
  assert.match(src, /aria-label="改这句话"/);
  assert.match(src, /canConfirm \? \(/);
  assert.doesNotMatch(src, /if \(canConfirm\) onConfirmStart/);
});

test("confirm panel keeps 噪音 and 字面≠意思, plus acoustic chips", () => {
  const src = readFileSync(new URL("../../../components/lover/confirm-turn.tsx", import.meta.url), "utf8");
  assert.match(src, />\s*噪音\s*</);
  assert.match(src, /字面≠意思/);
  assert.match(src, /aria-label="语气备注"/);
  assert.match(src, /toggleEventChip/);
  assert.match(src, /EVENT_CHIP_VALUES/);
  assert.match(src, /EVENT_CHIP_LABELS/);
  assert.doesNotMatch(src, /EMOTION_LABEL/);
  assert.doesNotMatch(src, /CueEmotion/);
  assert.doesNotMatch(src, /这是纯噪音/);
  assert.match(src, /<audio className="mb-3 w-full shrink-0" controls src=\{audioUrl\} \/>/);
  assert.doesNotMatch(src, /<audio[^>]*muted/);
});

test("transcript has 👎 below the reply, 24pt from play, both 44pt", () => {
  const src = readFileSync(new URL("../../../components/lover/transcript.tsx", import.meta.url), "utf8");
  assert.match(src, /onConfirmQuick/);
  assert.match(src, /aria-label="确认正确"/);
  assert.match(src, /aria-label="打开标注"/);
  assert.match(src, /aria-label="这条回复不好"/);
  assert.match(src, /ThumbsDown/);
  assert.match(src, /aria-label="播放这句话"/);
  const play = src.slice(src.indexOf('aria-label="播放这句话"'), src.indexOf('aria-label="这条回复不好"'));
  const flag = src.slice(src.indexOf('aria-label="这条回复不好"'), src.indexOf("thinking ?"));
  assert.match(play, /grid size-11/);
  assert.match(flag, /grid size-11/);
  assert.match(src, /flex-col gap-6 self-start/);
  assert.match(src, /talkTrace/);
  assert.match(src, /formatTalkTrace/);
  assert.doesNotMatch(src, /flex-col gap-1/);
});

test("voice room shows labeled count, volume meter, and writes final_text back", () => {
  const src = readFileSync(new URL("../../../components/lover/voice-room.tsx", import.meta.url), "utf8");
  assert.match(src, /已标 \$\{labeledCount\} \/ 200/);
  assert.match(src, /VolumeMeter/);
  assert.match(src, /patchHearingFinalText/);
  assert.match(src, /saveConfirmQuick/);
  assert.match(src, /armUndo/);
  assert.match(src, /unlabelHearingByTurn/);
  assert.match(src, /aria-label="阈值"/);
  assert.match(src, /historyForQingran/);
  assert.match(src, /kind: opts\?\.skipQingran \? "unheard" : "say"/);
  assert.match(src, /replyTo: userMsg.id/);
  assert.match(src, /patchHearingReplyId/);
  assert.match(src, /flagQingranReply/);
  assert.match(src, /result.noiseOnly/);
  assert.match(src, /result.literalMismatch/);
  assert.match(src, /result.toneNote/);
  assert.match(src, /initialNoise=\{confirmNoise\}/);
  assert.match(src, /micActionForConfirmPanel/);
  assert.match(src, /qingranSpeaking: status === "speaking" \|\| status === "thinking"/);
  assert.match(src, /POST_QINGRAN_MS/);
  assert.match(src, /setConfirmStt\(result\.xaiText\)/);
  assert.match(src, /UNRECOGNIZED_TEXT/);
  assert.match(src, /planConfirmSave/);
  assert.match(src, /sliceAfterMessage/);
  assert.match(src, /async function replayFrom/);
  assert.doesNotMatch(src, /alreadySent/);
  const save = src.slice(src.indexOf("async function saveConfirm"), src.indexOf("async function saveConfirmQuick"));
  assert.match(save, /void replayFrom/);
  assert.doesNotMatch(save, /await replayFrom/);
  assert.match(src, /正在想/);
  assert.match(src, /TALK_FAIL\.empty/);
  assert.match(src, /talkTrace/);
  assert.match(src, /event\.tts/);
  assert.match(src, /talkExceptionHint/);
  assert.doesNotMatch(src, /线路有点不稳，稍后再说/);
  const confirm = readFileSync(new URL("../../../components/lover/confirm-turn.tsx", import.meta.url), "utf8");
  assert.match(confirm, /disabled=\{busy\}/);
  assert.doesNotMatch(confirm, /status === "thinking"/);
});

test("call deafen ignores speech rec without aborting it", () => {
  const src = readFileSync(new URL("../../../hooks/use-call.ts", import.meta.url), "utf8");
  const deafen = src.slice(src.indexOf("const deafen = useCallback"), src.indexOf("const hear = useCallback"));
  assert.doesNotMatch(deafen, /recRef\.current\?\.abort/);
  assert.match(deafen, /pcmTapRef\.current\?\.stop/);
  assert.match(deafen, /setMicEnabled\(streamRef\.current, false\)/);
  assert.doesNotMatch(deafen, /stopCallHold/);
  assert.doesNotMatch(deafen, /ctxRef\.current\?\.close/);
  assert.doesNotMatch(deafen, /pauseMic\(/);
  const hear = src.slice(src.indexOf("const hear = useCallback"), src.indexOf("const revive = useCallback"));
  assert.match(hear, /startSpeechRec/);
  assert.match(src, /CALL_START_WARMUP_MS/);
  assert.match(src, /recLiveRef/);
  assert.match(src, /warmup-clear-ring/);
  const onend = src.slice(src.indexOf("rec.onend"), src.indexOf("recRef.current = rec"));
  assert.doesNotMatch(onend, /deafRef\.current/);
});

test("lab scorecard uses acoustic tag accuracy and has 👎 list", () => {
  const src = readFileSync(new URL("../../../routes/lab.tsx", import.meta.url), "utf8");
  assert.match(src, /声学标签/);
  assert.match(src, /tagAccuracy/);
  assert.match(src, /fmtEventPr/);
  assert.match(src, /TAG_EVENT_VALUES/);
  assert.match(src, /👎 列表/);
  assert.match(src, /exportReplyFlags/);
  assert.doesNotMatch(src, /语气符号准确率/);
  assert.doesNotMatch(src, /toneAccuracy/);
});

test("call and hold-to-talk pass peak_rms and trigger floor into hearUtterance", () => {
  const call = readFileSync(new URL("../../../hooks/use-call.ts", import.meta.url), "utf8");
  const hold = readFileSync(new URL("../../../hooks/use-voice-input.ts", import.meta.url), "utf8");
  assert.match(call, /peakRms:/);
  assert.match(call, /vadFloor: triggerFloorRef/);
  assert.match(call, /startThreshold/);
  assert.match(call, /MIN_SPEECH_MS/);
  assert.match(call, /canBeginUtterance/);
  assert.match(call, /speechRiseAtRef/);
  assert.match(hold, /vadFloor: triggerFloorRef/);
  assert.match(hold, /holdThreshold/);
  assert.match(hold, /holdToTalk: true/);
});

test("lab page is score card, worst 20, and hash export only", () => {
  const src = readFileSync(new URL("../../../routes/lab.tsx", import.meta.url), "utf8");
  assert.match(src, /最近 7 天/);
  assert.match(src, /CER 最终文字/);
  assert.match(src, /声学标签/);
  assert.match(src, /最差 20 条/);
  assert.match(src, /最近标注/);
  assert.match(src, /撤销标注/);
  assert.match(src, /listLabeledHearingClips/);
  assert.match(src, /导出 JSON/);
  assert.match(src, /hash 80\/20/);
  assert.match(src, /apple_empty/);
  assert.match(src, /short_quiet/);
  assert.match(src, /hallucinationByReason/);
  assert.match(src, /返回/);
  assert.match(src, /to="\/"/);
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
  assert.match(store, /apple_empty/);
  assert.match(store, /short_quiet/);
  assert.match(store, /holdToTalk/);
  assert.match(hear, /ranHearing \|\| provider === "xai"/);
  assert.match(hear, /transcribeVoice/);
  assert.match(hear, /hallucinationSuspect/);
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

test("confirm panel and settings drawer follow visualViewport and keep the caret visible", () => {
  const confirm = readFileSync(new URL("../../../components/lover/confirm-turn.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../../../components/lover/settings-drawer.tsx", import.meta.url), "utf8");
  assert.match(confirm, /useVisualViewportHeight\(open\)/);
  assert.match(confirm, /keepCaretVisible/);
  assert.match(confirm, /top: viewport\.offsetTop/);
  assert.match(confirm, /height: viewport\.height/);
  assert.match(confirm, /onSelect=\{\(e\) => caretOf\(e\.currentTarget\)\}/);
  assert.match(settings, /useVisualViewportHeight\(open\)/);
  assert.match(settings, /keepCaretVisible/);
  assert.match(settings, /top: viewport\.offsetTop/);
  assert.match(settings, /height: viewport\.height/);
  assert.match(settings, /写给模型的 system prompt/);
  assert.match(settings, /记下大事/);
});

test("flag sheet can cancel without recording", () => {
  const src = readFileSync(new URL("../../../components/lover/flag-reply.tsx", import.meta.url), "utf8");
  const start = src.indexOf('variant="outline"');
  const cancelBtn = src.slice(start, src.indexOf("</Button>", start));
  assert.match(cancelBtn, /取消/);
  assert.match(cancelBtn, /onClick=\{onClose\}/);
  assert.doesNotMatch(cancelBtn, /onSave/);
});

test("hold-to-talk teardown releases the mic; call hangup does too; deafen does not", () => {
  const hold = readFileSync(new URL("../../../hooks/use-voice-input.ts", import.meta.url), "utf8");
  const call = readFileSync(new URL("../../../hooks/use-call.ts", import.meta.url), "utf8");
  assert.match(hold, /releaseMic\(\)/);
  assert.doesNotMatch(hold, /pauseMic/);
  const teardown = call.slice(call.indexOf("const teardownMedia = useCallback"), call.indexOf("const hangup = useCallback"));
  assert.match(teardown, /releaseMic\(\)/);
  assert.doesNotMatch(teardown, /pauseMic/);
  const deafen = call.slice(call.indexOf("const deafen = useCallback"), call.indexOf("const hear = useCallback"));
  assert.doesNotMatch(deafen, /releaseMic/);
  assert.doesNotMatch(deafen, /pauseMic/);
  assert.match(deafen, /setMicEnabled\(streamRef\.current, false\)/);
});

test("idle hide/show does not write the audio session or grab the mic", () => {
  const src = readFileSync(new URL("../../../components/lover/voice-room.tsx", import.meta.url), "utf8");
  const bg = src.slice(src.indexOf("onBackground:"), src.indexOf("window.addEventListener(\"beforeunload\""));
  assert.match(bg, /callActiveRef\.current/);
  assert.match(bg, /stopPlayback/);
  assert.doesNotMatch(bg, /acquireMic/);
  assert.doesNotMatch(bg, /claimListenSession/);
  assert.doesNotMatch(bg, /setAudioSessionKind/);
  assert.doesNotMatch(bg, /unlockPlayback/);
  assert.doesNotMatch(bg, /resumeAudio/);
  assert.doesNotMatch(bg, /kickAudio/);
  assert.match(src, /installAudioTrace/);
});

test("debug settings show the timestamped audio trace", () => {
  const src = readFileSync(new URL("../../../components/lover/settings-drawer.tsx", import.meta.url), "utf8");
  assert.match(src, /音频日志/);
  assert.match(src, /formatCallAudioLogLines/);
  assert.match(src, /AudioTracePanel/);
});

test("audio trace records session, mic, rec, context, and page lifecycle", () => {
  const audio = readFileSync(new URL("../audio.ts", import.meta.url), "utf8");
  const session = readFileSync(new URL("../audio-session.ts", import.meta.url), "utf8");
  const log = readFileSync(new URL("../call-audio-log.ts", import.meta.url), "utf8");
  const hold = readFileSync(new URL("../../../hooks/use-voice-input.ts", import.meta.url), "utf8");
  assert.match(audio, /logCallAudio\("acquireMic"\)/);
  assert.match(audio, /logCallAudio\("pauseMic"\)/);
  assert.match(audio, /logCallAudio\(`releaseMic/);
  assert.match(audio, /logCallAudio\(`track \$\{event\}`\)/);
  assert.match(audio, /logCallAudio\("rec.stop"\)/);
  assert.match(hold, /logCallAudio\("rec.start"\)/);
  assert.match(hold, /logCallAudio\("rec.abort"\)/);
  assert.match(hold, /logCallAudio\("rec.onend"\)/);
  assert.match(session, /watchAudioContext/);
  assert.match(session, /AudioContext.resume/);
  assert.match(log, /visibilitychange/);
  assert.match(log, /pagehide/);
  assert.match(log, /pageshow/);
  assert.match(log, /freeze/);
  assert.match(log, /AUDIO_LOG_MAX = 80/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clipSaveBanner } from "./heard.ts";

test("storage failure banner keeps the original error", () => {
  assert.equal(clipSaveBanner("column stt_text does not exist"), "录音没存上：column stt_text does not exist");
});

test("settings hearing tab is 标注模式 plus 打开标注页, engines in 高级", () => {
  const src = readFileSync(new URL("../../../components/lover/settings-drawer.tsx", import.meta.url), "utf8");
  assert.match(src, />标注模式</);
  assert.doesNotMatch(src, />调试</);
  assert.doesNotMatch(src, /调试模式/);
  assert.doesNotMatch(src, /录音采集/);
  assert.doesNotMatch(src, /to="\/record"/);
  assert.match(src, /打开标注页/);
  assert.match(src, /to="\/lab"/);
  assert.match(src, />高级</);
  assert.match(src, /回复模型/);
  assert.match(src, /brainListVoiceModels/);
  assert.match(src, /voiceModel:/);
  assert.match(src, /voiceEffort:/);
  assert.match(src, /未使用/);
  assert.match(src, /supportsEffort/);
  assert.match(src, /VOICE_EFFORT_OPTIONS/);
  assert.match(src, /切换后下一句立刻生效/);
  assert.match(src, /grok-4\.20-0309-non-reasoning 再试一次/);
  assert.doesNotMatch(src, /VOICE_CHAT_OPTIONS/);
  assert.doesNotMatch(src, /VoiceChatId/);
  const types = readFileSync(new URL("../types.ts", import.meta.url), "utf8");
  assert.match(types, /DEFAULT_VOICE_MODEL = "grok-4\.3"/);
  assert.match(types, /voiceModel: string/);
  assert.match(types, /voiceEffort: VoiceEffort/);
  assert.match(types, /VOICE_EFFORT_OPTIONS/);
  assert.doesNotMatch(types, /VoiceChatId/);
  assert.doesNotMatch(types, /DEFAULT_VOICE_CHAT/);
  const api = readFileSync(new URL("../brain/api.ts", import.meta.url), "utf8");
  assert.match(api, /brainListVoiceModels/);
  assert.match(api, /listVoiceCatalog/);
  assert.match(api, /voiceModelStatsLast7d/);
  assert.match(src, /引擎自检/);
  assert.match(src, /hearingConnectionTest/);
  assert.match(src, /让她忘掉最近还没记住的对话？已经记住的事和故事线不受影响。/);
  assert.match(src, /clearArmed/);
  assert.match(src, /确定清空/);
  assert.match(src, /logFailFirstLine/);
  assert.match(src, /row\.note \|\| row\.error/);
  assert.doesNotMatch(src, /row\.error \|\| row\.note/);
  assert.match(src, /logFinishReason/);
  assert.match(src, /\.slice\(0, 1000\)/);
  assert.match(src, /finish_reason/);
  assert.match(src, /input_chars/);
  assert.match(src, /logInputChars/);
  assert.match(src, /parseVoiceInputCharsLine/);
  assert.match(src, /记忆笔记/);
  assert.match(src, /对话历史/);
  assert.match(src, /用户消息/);
  assert.match(src, /静音判定/);
  assert.match(src, /SILENCE_MS_OPTIONS/);
  assert.match(src, /1\.5 秒/);
  assert.match(src, /会拖慢识别/);
  assert.match(src, /最近听力耗时/);
  assert.match(src, /parseHearingTimingLine/);
  assert.match(src, /\.slice\(0, 20\)/);
  assert.doesNotMatch(src, /定向录制/);
  assert.doesNotMatch(src, /hearingNbest/);
  assert.match(src, /把内心写进回复/);
  assert.match(src, />高级</);
  assert.match(src, /确认删除这些笔记/);
  assert.match(src, /brainListHygieneNotes/);
  assert.match(src, /brainDeleteHygieneNotes/);
  assert.match(src, /injectMind/);
});

test("settings prompts tab edits catalog steps and log expand shows assembled prompt", () => {
  const src = readFileSync(new URL("../../../components/lover/settings-drawer.tsx", import.meta.url), "utf8");
  assert.match(src, /\["prompts", "指令"\]/);
  assert.match(src, /brainListPrompts/);
  assert.match(src, /brainSavePrompt/);
  assert.match(src, /brainRestorePrompt/);
  assert.match(src, /恢复默认/);
  assert.match(src, /\{system_prompt\}/);
  assert.match(src, /brainGetCallLog/);
  assert.match(src, /brainListLogs/);
  assert.match(src, /复制全部/);
  assert.match(src, />输入</);
  assert.match(src, />输出</);
  assert.match(src, />参数与耗时</);
  assert.match(src, /记录保留 30 天/);
  assert.match(src, /loadCall/);
  const api = readFileSync(new URL("../brain/api.ts", import.meta.url), "utf8");
  assert.match(api, /brainListPrompts/);
  assert.match(api, /brainSavePrompt/);
  assert.match(api, /brainRestorePrompt/);
  assert.match(api, /assembled/);
  assert.match(api, /brainListLogs/);
  assert.match(api, /messagesFromStored/);
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
  assert.match(src, /hearingTiming\.engine/);
  assert.doesNotMatch(src, /if \(canConfirm\) onConfirmStart/);
});

test("confirm panel keeps 噪音 and optional note, drops acoustic chips", () => {
  const src = readFileSync(new URL("../../../components/lover/confirm-turn.tsx", import.meta.url), "utf8");
  assert.match(src, />\s*噪音\s*</);
  assert.doesNotMatch(src, /字面≠意思/);
  assert.match(src, /aria-label="语气备注"/);
  assert.doesNotMatch(src, /toggleEventChip/);
  assert.doesNotMatch(src, /EVENT_CHIP_VALUES/);
  assert.doesNotMatch(src, /EVENT_CHIP_LABELS/);
  assert.doesNotMatch(src, /EMOTION_LABEL/);
  assert.doesNotMatch(src, /CueEmotion/);
  assert.doesNotMatch(src, /这是纯噪音/);
  assert.match(src, /<audio className="mb-3 w-full shrink-0" controls src=\{audioUrl\} \/>/);
  assert.doesNotMatch(src, /<audio[^>]*muted/);
  assert.doesNotMatch(src, /未预测/);
  assert.match(src, /goldTextForSave/);
  assert.match(src, /confirmNoiseOnly/);
  assert.match(src, /source: !goldText \|\| goldText !== sttText\.trim\(\) \? "edited" : "confirmed"/);
});

test("transcript has 差在哪 below the reply, 44pt targets, no thumbs-down", () => {
  const src = readFileSync(new URL("../../../components/lover/transcript.tsx", import.meta.url), "utf8");
  assert.match(src, /onConfirmQuick/);
  assert.match(src, /aria-label="确认正确"/);
  assert.match(src, /aria-label="打开标注"/);
  assert.match(src, /aria-label="差在哪"/);
  assert.match(src, /aria-label="这条回复好"/);
  assert.doesNotMatch(src, /aria-label="这条回复不好"/);
  assert.doesNotMatch(src, /ThumbsDown/);
  assert.match(src, /ThumbsUp/);
  assert.match(src, /aria-label="播放这句话"/);
  const play = src.slice(src.indexOf('aria-label="播放这句话"'), src.indexOf('aria-label="这条回复好"'));
  const flag = src.slice(src.indexOf('aria-label="这条回复好"'), src.indexOf("thinking ?"));
  assert.match(play, /grid size-11/);
  assert.match(flag, /grid size-11/);
  assert.match(flag, /min-h-11/);
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
  assert.match(src, /replyId: reply.id/);
  assert.match(src, /patchHearingReplyId/);
  assert.match(src, /flagQingranReply/);
  assert.match(src, /saveReplyFlag/);
  assert.match(src, /rating: "up"/);
  assert.match(src, /rating: "down"/);
  assert.match(src, /tags: input.tags/);
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
  assert.match(src, /engineLineFromHeard/);
  assert.doesNotMatch(src, /alreadySent/);
  const save = src.slice(src.indexOf("async function saveConfirm"), src.indexOf("async function saveConfirmQuick"));
  assert.match(save, /void replayFrom/);
  assert.doesNotMatch(save, /await replayFrom/);
  assert.match(save, /plan\.removed/);
  assert.match(save, /deleteRoomMessages/);
  assert.doesNotMatch(save, /input\.goldText\.trim\(\) \|\| msg\.text/);
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
  assert.doesNotMatch(deafen, /setMicEnabled\(streamRef\.current, false\)/);
  assert.doesNotMatch(deafen, /stopCallHold/);
  assert.doesNotMatch(deafen, /ctxRef\.current\?\.close/);
  assert.doesNotMatch(deafen, /pauseMic\(/);
  const hear = src.slice(src.indexOf("const hear = useCallback"), src.indexOf("const revive = useCallback"));
  assert.match(hear, /startSpeechRec/);
  assert.doesNotMatch(hear, /pcmTapRef\.current\?\.clear/);
  assert.match(hear, /POST_QINGRAN_MS/);
  assert.match(src, /CALL_START_WARMUP_MS/);
  assert.match(src, /recLiveRef/);
  assert.match(src, /warmup-clear-ring/);
  assert.match(src, /hearToTriggerMs/);
  assert.match(src, /prerollPeakRms/);
  const onend = src.slice(src.indexOf("rec.onend"), src.indexOf("recRef.current = rec"));
  assert.doesNotMatch(onend, /deafRef\.current/);
});

test("lab scorecard keeps punctuation accuracy and drops tag stats", () => {
  const src = readFileSync(new URL("../../../routes/lab.tsx", import.meta.url), "utf8");
  assert.match(src, /语气符号准确率/);
  assert.match(src, /toneAccuracy/);
  assert.doesNotMatch(src, /声学标签/);
  assert.doesNotMatch(src, /tagAccuracy/);
  assert.doesNotMatch(src, /fmtEventPr/);
  assert.doesNotMatch(src, /TAG_EVENT_VALUES/);
  assert.doesNotMatch(src, /引擎占比/);
  assert.doesNotMatch(src, /formatEngineMix/);
  assert.match(src, /👎 列表/);
  assert.match(src, /exportReplyFlags/);
  assert.match(src, /countReplyDownTags/);
  assert.match(src, /按标签筛选/);
  assert.match(src, /feedbackTag/);
  assert.match(src, /row\.tags/);
  assert.match(src, /这个标签还没有反馈/);
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
  assert.match(call, /silenceMs: getHearingSession\(\)\.silenceMs/);
  assert.match(call, /silenceWaitMs/);
  assert.match(hold, /vadFloor: triggerFloorRef/);
  assert.match(hold, /holdThreshold/);
  assert.match(hold, /holdToTalk: true/);
});

test("lab page is score card, worst 20, labels, homophones, and hash export", () => {
  const src = readFileSync(new URL("../../../routes/lab.tsx", import.meta.url), "utf8");
  assert.match(src, /最近 7 天/);
  assert.match(src, /CER 最终文字/);
  assert.match(src, /语气符号准确率/);
  assert.match(src, /最差 20 条/);
  assert.match(src, /最近标注/);
  assert.match(src, /撤销标注/);
  assert.match(src, /listLabeledHearingClips/);
  assert.match(src, /同音词/);
  assert.match(src, /listHearingConfusionRules/);
  assert.match(src, /回填韵律/);
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
  assert.doesNotMatch(src, /引擎对比/);
  assert.doesNotMatch(src, /引擎自检/);
});

test("lab engine compare stays in store but is off the lab page", () => {
  const src = readFileSync(new URL("../../../routes/lab.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /引擎对比/);
  assert.doesNotMatch(src, /引擎自检/);
  assert.doesNotMatch(src, /hearingConnectionTest/);
  assert.doesNotMatch(src, /runEngineEvalBatch/);
  assert.doesNotMatch(src, /hearingEvalCompare/);
  assert.doesNotMatch(src, /exportEvalCompare/);
  const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  assert.match(store, /EVAL_BATCH_SIZE/);
  assert.match(store, /export const runEngineEvalBatch/);
  const batch = store.slice(
    store.indexOf("export const runEngineEvalBatch"),
    store.indexOf("export const hearingEvalCompare"),
  );
  assert.match(batch, /EVAL_BATCH_SIZE/);
  assert.match(batch, /runEvalJob/);
  assert.match(batch, /listEvalClipIds/);
  assert.doesNotMatch(batch, /persistHearingTurn/);
  assert.doesNotMatch(batch, /insertClipRow/);
  assert.doesNotMatch(batch, /qingran_messages/);
  assert.doesNotMatch(batch, /qingran_hearing_turns/);
  const job = store.slice(store.indexOf("async function runEvalJob"), store.indexOf("async function persistHearingTurn"));
  assert.match(job, /upsertEvalRun/);
  assert.match(job, /evalClipAudioRow/);
  assert.match(job, /没有这段录音/);
  assert.doesNotMatch(job, /persistHearingTurn/);
  assert.doesNotMatch(job, /insertClipRow/);
  assert.doesNotMatch(job, /qingran_messages/);
  assert.doesNotMatch(job, /qingran_hearing_turns/);
  assert.doesNotMatch(job, /upsertTurn/);
});

test("runHearing persists with waitUntil; xai skips audio-LLM and a second STT", () => {
  const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  const hear = readFileSync(new URL("../hear.ts", import.meta.url), "utf8");
  const persist = readFileSync(new URL("./persist.ts", import.meta.url), "utf8");
  const cron = readFileSync(new URL("../../../routes/api/cron/brain.ts", import.meta.url), "utf8");
  const run = store.slice(store.indexOf("export const runHearing"), store.indexOf("const xaiPromise"));
  assert.doesNotMatch(run, /getSql\(/);
  assert.doesNotMatch(run, /hearingSttKeyterms/);
  assert.doesNotMatch(run, /listHearingConfusions/);
  assert.doesNotMatch(run, /maybeRebuildLexicon/);
  assert.match(store, /hotPathHearingStt/);
  assert.match(store, /backgroundRefreshHearingStt/);
  assert.match(store, /recordHearingTimingLog/);
  assert.match(hear, /silenceWaitMs/);
  assert.match(persist, /Talk hot path must use hotPathHearingStt/);
  assert.doesNotMatch(
    persist.slice(persist.indexOf("export async function lexiconKeyterms"), persist.indexOf("export async function hearingSttKeyterms")),
    /maybeRebuildLexicon/,
  );
  assert.match(cron, /maybeRebuildLexicon/);
  assert.match(store, /from "@vercel\/functions"/);
  assert.match(store, /waitUntil\(/);
  assert.match(store, /provider === "xai" \? Promise.resolve\(null\)/);
  assert.match(store, /prefer_apple_quiet/);
  assert.match(store, /apple_empty/);
  assert.match(store, /short_quiet/);
  assert.match(store, /holdToTalk/);
  assert.match(store, /engine_fallback_reason/);
  assert.match(store, /engine_error_detail/);
  assert.match(store, /engineErrorDetailFromOutcome/);
  assert.match(store, /hearingConnectionTest/);
  assert.match(store, /silenceWavBase64\(1\)/);
  assert.match(store, /isLabEvalEngine/);
  assert.match(store, /isQwenHearingModel/);
  assert.match(store, /hearWithQwen\(audioBase64, undefined, id\)/);
  assert.match(store, /lengthOnlyTags\(data\.predictedTags\)/);
  assert.match(store, /used !== "xai" \? withMeowFromText/);
  assert.match(hear, /ranHearing \|\| provider === "xai"/);
  assert.match(hear, /transcribeVoice/);
  assert.match(hear, /hallucinationSuspect/);
  assert.match(hear, /engine_fallback_reason/);
  assert.match(hear, /engine_error_detail/);
  assert.match(hear, /engineRequested/);
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
  assert.match(src, /首字/);
  assert.match(src, /→出声/);
  assert.match(src, /hearingTiming\.engine/);
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
  assert.match(src, /REPLY_DOWN_TAGS/);
  assert.match(src, /差在哪/);
  assert.match(src, /一行备注，可选/);
  assert.match(src, /onSave\(\{ note: note.trim\(\), tags \}\)/);
  assert.match(src, /tags.length === 0/);
  assert.doesNotMatch(src, /rating\?:/);
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
  assert.doesNotMatch(deafen, /setMicEnabled\(streamRef\.current, false\)/);
});

test("idle hide/show does not write the audio session or grab the mic", () => {
  const src = readFileSync(new URL("../../../components/lover/voice-room.tsx", import.meta.url), "utf8");
  const bg = src.slice(src.indexOf("onBackground:"), src.indexOf("async function sweepOverflow"));
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

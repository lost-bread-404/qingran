import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clipSaveBanner,
  errorText,
  heardFromHearing,
  shouldRecordHearing,
  UNRECOGNIZED_TEXT,
  voiceTurnIdForMessage,
} from "./heard.ts";
import { scrubHallucination } from "../stt-text.ts";

function decideHeard(input: {
  liveText: string;
  xaiText: string;
  holdToTalk?: boolean;
  durationSec?: number;
  peakRms?: number;
}) {
  const audio = {
    durationSec: input.durationSec ?? 2,
    peakRms: input.peakRms ?? 0.08,
  };
  const scrubbed = scrubHallucination(input.xaiText, audio, input.liveText, {
    holdToTalk: input.holdToTalk,
  });
  return heardFromHearing({
    debugHearing: true,
    turnId: "t-hall",
    tagged: scrubbed.suspect ? "" : input.xaiText,
    xaiText: input.xaiText,
    noiseOnly: false,
    clipId: "c-hall",
    hallucinationSuspect: scrubbed.suspect,
    hallucinationReason:
      scrubbed.reason === "apple_empty" || scrubbed.reason === "short_quiet" ? scrubbed.reason : undefined,
  });
}

test("debug empty recognition becomes 未识别 and is not sent", () => {
  const heard = heardFromHearing({
    debugHearing: true,
    turnId: "t1",
    tagged: "",
    xaiText: "",
    noiseOnly: true,
    clipId: "c1",
  });
  assert.equal(heard.text, UNRECOGNIZED_TEXT);
  assert.equal(heard.skipQingran, true);
  assert.equal(voiceTurnIdForMessage(heard), "t1");
});

test("debug keeps a normal transcript and sends it", () => {
  const heard = heardFromHearing({
    debugHearing: true,
    turnId: "t2",
    tagged: "在吗",
    xaiText: "在吗",
    noiseOnly: false,
    clipId: "c2",
  });
  assert.equal(heard.text, "在吗");
  assert.equal(heard.skipQingran, false);
});

test("voiceTurnId is omitted until the clip actually saved", () => {
  const heard = heardFromHearing({
    debugHearing: true,
    turnId: "t3",
    tagged: "嗯",
    xaiText: "嗯",
    noiseOnly: false,
    saveError: "column stt_text does not exist",
  });
  assert.equal(voiceTurnIdForMessage({ turnId: heard.turnId, clipId: heard.clipId }), undefined);
  assert.equal(voiceTurnIdForMessage(heard), "t3");
  assert.match(clipSaveBanner(heard.saveError ?? ""), /录音没存上/);
});

test("non-debug does not record silence or a miss; debug still does", () => {
  assert.equal(shouldRecordHearing({ debugHearing: false, text: "" }), false);
  assert.equal(shouldRecordHearing({ debugHearing: false, text: "   " }), false);
  assert.equal(shouldRecordHearing({ debugHearing: false, text: "在吗" }), true);
  assert.equal(shouldRecordHearing({ debugHearing: true, text: "" }), true);
});

test("non-debug empty still returns blank so the UI can say 没听清", () => {
  const heard = heardFromHearing({
    debugHearing: false,
    turnId: "t4",
    tagged: "",
    xaiText: "",
    noiseOnly: true,
  });
  assert.equal(heard.text, "");
  assert.equal(heard.skipQingran, false);
});

test("debug empty still persists a clip id when save succeeded", () => {
  const heard = heardFromHearing({
    debugHearing: true,
    turnId: "t5",
    tagged: "",
    xaiText: "",
    noiseOnly: true,
    clipId: "c5",
  });
  assert.equal(heard.skipQingran, true);
  assert.equal(heard.clipId, "c5");
  assert.equal(voiceTurnIdForMessage(heard), "t5");
});

test("errorText keeps postgres code and message", () => {
  assert.match(
    errorText({ message: "column stt_text does not exist", code: "42703" }),
    /42703/,
  );
});

test("Apple empty + xAI 嗷呜～ is sent as a vocal cue", () => {
  const heard = decideHeard({ liveText: "", xaiText: "嗷呜～" });
  assert.equal(heard.skipQingran, false);
  assert.equal(heard.hallucinationSuspect, false);
  assert.match(heard.text, /嗷呜/);
});

test("Apple empty + xAI 谢谢观看 becomes 未识别 and is not sent", () => {
  const heard = decideHeard({ liveText: "", xaiText: "谢谢观看" });
  assert.equal(heard.text, UNRECOGNIZED_TEXT);
  assert.equal(heard.skipQingran, true);
  assert.equal(heard.hallucinationSuspect, true);
  assert.equal(heard.hallucinationReason, "apple_empty");
  assert.equal(heard.clipId, "c-hall");
});

test("Apple empty + xAI long sentence becomes 未识别 and is not sent", () => {
  const heard = decideHeard({ liveText: "", xaiText: "林泽是一个中国的演员今天也来了" });
  assert.equal(heard.text, UNRECOGNIZED_TEXT);
  assert.equal(heard.skipQingran, true);
  assert.equal(heard.hallucinationSuspect, true);
  assert.equal(heard.hallucinationReason, "apple_empty");
});

test("hold-to-talk + Apple empty + xAI content is sent", () => {
  const heard = decideHeard({ liveText: "", xaiText: "我想你了", holdToTalk: true });
  assert.equal(heard.skipQingran, false);
  assert.equal(heard.hallucinationSuspect, false);
  assert.match(heard.text, /我想你了/);
});

test("heardFromHearing keeps engine debug fields", () => {
  const heard = heardFromHearing({
    debugHearing: true,
    turnId: "t-e",
    tagged: "嗯",
    xaiText: "嗯",
    noiseOnly: false,
    engineRequested: "gemini",
    engineUsed: "xai",
    engineFallback: "timeout",
    audioLlmMs: 8000,
  });
  assert.equal(heard.engineRequested, "gemini");
  assert.equal(heard.engineUsed, "xai");
  assert.equal(heard.engineFallback, "timeout");
  assert.equal(heard.audioLlmMs, 8000);
});

test("heardFromHearing keeps http error detail for debug", () => {
  const heard = heardFromHearing({
    debugHearing: true,
    turnId: "t-http",
    tagged: "嗯",
    xaiText: "嗯",
    noiseOnly: false,
    engineRequested: "gemini",
    engineUsed: "xai",
    engineFallback: "http",
    engineErrorDetail: '503 {"error":"UNAVAILABLE"}',
  });
  assert.equal(heard.engineFallback, "http");
  assert.equal(heard.engineErrorDetail, '503 {"error":"UNAVAILABLE"}');
});

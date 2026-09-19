import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clipSaveBanner,
  errorText,
  heardFromHearing,
  UNRECOGNIZED_TEXT,
  voiceTurnIdForMessage,
} from "./heard.ts";

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
  assert.equal(voiceTurnIdForMessage(heard), undefined);
  assert.match(clipSaveBanner(heard.saveError ?? ""), /录音没存上/);
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

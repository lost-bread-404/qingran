import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  micActionForConfirmPanel,
  planOpenConfirmPanel,
  shouldAutoSpeakReply,
} from "./confirm-call.ts";

test("opening the confirm panel deafens an active call", () => {
  assert.equal(
    micActionForConfirmPanel({
      panelOpen: true,
      wasOpen: false,
      callActive: true,
      qingranSpeaking: false,
    }),
    "deafen",
  );
});

test("closing the confirm panel restores listen", () => {
  assert.equal(
    micActionForConfirmPanel({
      panelOpen: false,
      wasOpen: true,
      callActive: true,
      qingranSpeaking: false,
    }),
    "hear",
  );
});

test("closing while Qingran is speaking does not call hear", () => {
  assert.equal(
    micActionForConfirmPanel({
      panelOpen: false,
      wasOpen: true,
      callActive: true,
      qingranSpeaking: true,
    }),
    null,
  );
});

test("no call means no mic action", () => {
  assert.equal(
    micActionForConfirmPanel({
      panelOpen: true,
      wasOpen: false,
      callActive: false,
      qingranSpeaking: false,
    }),
    null,
  );
  assert.equal(
    micActionForConfirmPanel({
      panelOpen: false,
      wasOpen: true,
      callActive: false,
      qingranSpeaking: false,
    }),
    null,
  );
});

test("opening ✎ hushes playback without aborting or marking interrupted", () => {
  assert.deepEqual(planOpenConfirmPanel(), {
    stopPlayback: true,
    skipAutoPlay: true,
    abort: false,
    markInterrupted: false,
  });
});

test("skipAutoPlay blocks auto-speak even when not muted", () => {
  assert.equal(shouldAutoSpeakReply({ muted: false, skipAutoPlay: false }), true);
  assert.equal(shouldAutoSpeakReply({ muted: true, skipAutoPlay: false }), false);
  assert.equal(shouldAutoSpeakReply({ muted: false, skipAutoPlay: true }), false);
  assert.equal(shouldAutoSpeakReply({ muted: true, skipAutoPlay: true }), false);
});

test("voice-room: opening ✎ stops playback, keeps generating, and does not catch up", () => {
  const src = readFileSync(new URL("../../../components/lover/voice-room.tsx", import.meta.url), "utf8");
  const start = src.slice(src.indexOf("onConfirmStart="), src.indexOf("onConfirmQuick="));
  assert.match(start, /planOpenConfirmPanel/);
  assert.match(start, /stopPlayback\(\)/);
  assert.match(start, /skipAutoPlayRef\.current = plan\.skipAutoPlay/);
  assert.doesNotMatch(start, /abortRef/);
  assert.doesNotMatch(start, /interrupted/);
  assert.doesNotMatch(start, /INTERRUPTED_MARK/);

  const send = src.slice(src.indexOf("const sendTurn = useCallback"), src.indexOf("const call = useCall"));
  assert.match(send, /skipAutoPlayRef\.current = false/);
  assert.match(send, /shouldAutoSpeakReply/);
  assert.match(send, /paintText\(full/);
  const audio = send.slice(send.indexOf('if (event.t === "audio")'), send.indexOf('event.t === "err"'));
  assert.match(audio, /shouldAutoSpeakReply/);
  const done = send.slice(send.indexOf('if (event.t === "done")'), send.indexOf('if (event.t === "audio")'));
  assert.match(done, /shouldAutoSpeakReply/);
  assert.match(done, /paintText\(full, true\)/);
  assert.match(done, /void playFull/);

  const close = src.slice(src.indexOf("onClose={() => {"), src.indexOf("onConfirm={(input)"));
  assert.doesNotMatch(close, /playFull/);
  assert.doesNotMatch(close, /enqueuePlayback/);
  assert.doesNotMatch(close, /skipAutoPlayRef\.current = false/);
  assert.match(src, /if \(confirmOpenRef\.current\) return/);
});

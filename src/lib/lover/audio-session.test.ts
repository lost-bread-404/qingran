import assert from "node:assert/strict";
import { test } from "node:test";
import {
  audioContextNeedsResume,
  createAppLifecycleGate,
  isInterruptedState,
  micStreamHearing,
  micStreamUsable,
  micTrackHearing,
  micTrackUsable,
  sessionIsActive,
  sessionTypeFor,
  sessionTypeIfChanged,
} from "./audio-session.ts";

test("audio context treats iOS interrupted like suspended", () => {
  assert.equal(audioContextNeedsResume("suspended"), true);
  assert.equal(audioContextNeedsResume("interrupted"), true);
  assert.equal(audioContextNeedsResume("running"), false);
  assert.equal(audioContextNeedsResume("closed"), false);
});

test("interrupted session states cover WebKit variants", () => {
  assert.equal(isInterruptedState("interrupted"), true);
  assert.equal(isInterruptedState("interrupted-by-system"), true);
  assert.equal(isInterruptedState("active"), false);
  assert.equal(isInterruptedState("inactive"), false);
  assert.equal(isInterruptedState(""), false);
  assert.equal(isInterruptedState(null), false);
});

test("only an active session should resume capture after an alarm", () => {
  assert.equal(sessionIsActive("active"), true);
  assert.equal(sessionIsActive("inactive"), false);
  assert.equal(sessionIsActive("interrupted"), false);
  assert.equal(sessionIsActive(""), false);
  assert.equal(sessionIsActive(null), false);
});

test("a live call keeps play-and-record; only hangup yields the session", () => {
  assert.equal(sessionTypeFor("listen"), "play-and-record");
  assert.equal(sessionTypeFor("speak"), "play-and-record");
  assert.equal(sessionTypeFor("yield"), "ambient");
});

test("rewriting play-and-record is skipped so iOS does not click or duck", () => {
  assert.equal(sessionTypeIfChanged("play-and-record", "listen"), null);
  assert.equal(sessionTypeIfChanged("play-and-record", "speak"), null);
  assert.equal(sessionTypeIfChanged("ambient", "listen"), "play-and-record");
  assert.equal(sessionTypeIfChanged("auto", "listen"), "play-and-record");
  assert.equal(sessionTypeIfChanged(undefined, "listen"), "play-and-record");
  assert.equal(sessionTypeIfChanged("play-and-record", "yield"), "ambient");
  assert.equal(sessionTypeIfChanged("ambient", "yield"), "ambient");
});


test("live tracks are reusable even when iOS starts them muted", () => {
  assert.equal(micTrackUsable({ readyState: "live", muted: false }), true);
  assert.equal(micTrackUsable({ readyState: "live", muted: true }), true);
  assert.equal(micTrackUsable({ readyState: "ended", muted: false }), false);
  assert.equal(micTrackHearing({ readyState: "live", muted: false }), true);
  assert.equal(micTrackHearing({ readyState: "live", muted: true }), false);
});

test("ended streams are not reused; muted live streams are not yet hearing", () => {
  const live = {
    active: true,
    getAudioTracks: () => [{ readyState: "live", muted: false }],
  };
  const muted = {
    active: true,
    getAudioTracks: () => [{ readyState: "live", muted: true }],
  };
  const ended = {
    active: false,
    getAudioTracks: () => [{ readyState: "ended", muted: false }],
  };
  assert.equal(micStreamUsable(live), true);
  assert.equal(micStreamUsable(muted), true);
  assert.equal(micStreamUsable(ended), false);
  assert.equal(micStreamUsable(null), false);
  assert.equal(micStreamHearing(live), true);
  assert.equal(micStreamHearing(muted), false);
  assert.equal(micStreamHearing(ended), false);
});

test("app lifecycle only emits when actually leaving or returning", () => {
  const gate = createAppLifecycleGate(false);
  assert.equal(gate.notify(false), null);
  assert.equal(gate.notify(true), "background");
  assert.equal(gate.notify(true), null);
  assert.equal(gate.notify(false), "foreground");
  assert.equal(gate.notify(false), null);
  assert.equal(gate.inBackground, false);
});

test("starting already hidden does not emit a fake return on the first hide", () => {
  const gate = createAppLifecycleGate(true);
  assert.equal(gate.notify(true), null);
  assert.equal(gate.notify(false), "foreground");
});

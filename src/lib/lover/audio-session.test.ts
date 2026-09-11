import assert from "node:assert/strict";
import { test } from "node:test";
import {
  audioContextNeedsResume,
  isInterruptedState,
  micStreamUsable,
  micTrackUsable,
  sessionIsActive,
  sessionTypeFor,
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

test("listen claims the call session, speak and yield mix so alarms can ring", () => {
  assert.equal(sessionTypeFor("listen"), "play-and-record");
  assert.equal(sessionTypeFor("speak"), "ambient");
  assert.equal(sessionTypeFor("yield"), "ambient");
});

test("live unmuted tracks are usable", () => {
  assert.equal(micTrackUsable({ readyState: "live", muted: false }), true);
  assert.equal(micTrackUsable({ readyState: "live", muted: true }), false);
  assert.equal(micTrackUsable({ readyState: "ended", muted: false }), false);
});

test("muted or inactive streams are not reused after iOS backgrounds the app", () => {
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
  assert.equal(micStreamUsable(muted), false);
  assert.equal(micStreamUsable(ended), false);
  assert.equal(micStreamUsable(null), false);
});

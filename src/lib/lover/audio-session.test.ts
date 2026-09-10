import assert from "node:assert/strict";
import { test } from "node:test";
import {
  audioContextNeedsResume,
  micStreamUsable,
  micTrackUsable,
} from "./audio-session.ts";

test("audio context treats iOS interrupted like suspended", () => {
  assert.equal(audioContextNeedsResume("suspended"), true);
  assert.equal(audioContextNeedsResume("interrupted"), true);
  assert.equal(audioContextNeedsResume("running"), false);
  assert.equal(audioContextNeedsResume("closed"), false);
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

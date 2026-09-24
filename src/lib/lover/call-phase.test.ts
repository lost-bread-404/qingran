import assert from "node:assert/strict";
import { test } from "node:test";
import { callListenStuck } from "./call-phase.ts";
import { floorUpdateAllowed, nextFloor, NOISE_FLOOR_CAP, shouldTrackNoiseFloor } from "./vad.ts";

test("noise floor stops climbing at the cap and can still fall", () => {
  let floor = 0.018;
  for (let i = 0; i < 80; i += 1) floor = nextFloor(floor, 0.04, false);
  assert.ok(floor <= NOISE_FLOOR_CAP + 1e-9);
  assert.ok(floor > 0.019);
  const louder = nextFloor(0.03, 0.04, false);
  assert.equal(louder, 0.03);
  const quieter = nextFloor(0.03, 0.008, false);
  assert.ok(quieter < 0.03);
});

test("Qingran's voice and the 300ms after it do not move the floor", () => {
  assert.equal(shouldTrackNoiseFloor({ qingranSpeaking: true, quietForMs: 5_000 }), false);
  assert.equal(shouldTrackNoiseFloor({ qingranSpeaking: false, quietForMs: 299 }), false);
  assert.equal(shouldTrackNoiseFloor({ qingranSpeaking: false, quietForMs: 300 }), true);
  assert.equal(
    floorUpdateAllowed({
      playbackActive: true,
      msSincePlayback: 0,
      qingranStatusSpeaking: false,
      msSinceStatusQuiet: 5_000,
    }),
    false,
  );
  assert.equal(
    floorUpdateAllowed({
      playbackActive: false,
      msSincePlayback: 299,
      qingranStatusSpeaking: false,
      msSinceStatusQuiet: 5_000,
    }),
    false,
  );
  assert.equal(
    floorUpdateAllowed({
      playbackActive: false,
      msSincePlayback: 300,
      qingranStatusSpeaking: true,
      msSinceStatusQuiet: 0,
    }),
    false,
  );
  assert.equal(
    floorUpdateAllowed({
      playbackActive: false,
      msSincePlayback: 300,
      qingranStatusSpeaking: false,
      msSinceStatusQuiet: 300,
    }),
    true,
  );
});

test("a deaf call that is not playing, thinking, or transcribing is stuck after 5s", () => {
  const idle = {
    phase: "listening",
    deaf: true,
    playing: false,
    generating: false,
    recognizing: false,
    labeling: false,
  };
  assert.equal(callListenStuck({ ...idle, stuckForMs: 4_999 }), false);
  assert.equal(callListenStuck({ ...idle, stuckForMs: 5_000 }), true);
  assert.equal(callListenStuck({ ...idle, stuckForMs: 9_000, playing: true }), false);
  assert.equal(callListenStuck({ ...idle, stuckForMs: 9_000, generating: true }), false);
  assert.equal(callListenStuck({ ...idle, stuckForMs: 9_000, recognizing: true }), false);
  assert.equal(callListenStuck({ ...idle, stuckForMs: 9_000, labeling: true }), false);
  assert.equal(callListenStuck({ ...idle, phase: "speaking-you", deaf: false, stuckForMs: 20_000 }), false);
  assert.equal(callListenStuck({ ...idle, deaf: false, stuckForMs: 20_000 }), false);
  assert.equal(callListenStuck({ ...idle, phase: "idle", stuckForMs: 5_000 }), true);
  assert.equal(callListenStuck({ ...idle, phase: "transcribing", deaf: true, recognizing: false, stuckForMs: 5_000 }), true);
  assert.equal(callListenStuck({ ...idle, phase: "transcribing", deaf: true, recognizing: true, stuckForMs: 20_000 }), false);
});

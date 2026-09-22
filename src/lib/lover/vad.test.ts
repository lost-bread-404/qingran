import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canBeginUtterance,
  DEBUG_START_FLOOR_MIN,
  DEBUG_START_FLOOR_MULT,
  holdThreshold,
  isHoldVoiced,
  isSpeechStart,
  MIN_SPEECH_MS,
  nextFloor,
  POST_QINGRAN_MS,
  SILENCE_MS,
  shouldEndUtterance,
  START_FLOOR_MIN,
  START_FLOOR_MULT,
  startThreshold,
} from "./vad.ts";

test("noise floor tracks ambient while listening and ignores loud speech", () => {
  let floor = 0.008;
  for (let i = 0; i < 40; i += 1) floor = nextFloor(floor, 0.012, false);
  assert.ok(floor > 0.01 && floor < 0.014);
  const afterSpeech = nextFloor(floor, 0.22, true);
  assert.equal(afterSpeech, floor);
});

test("speech start stays above a noisy room floor", () => {
  const floor = 0.02;
  assert.equal(isSpeechStart(0.021, floor, 0, 0.05), false);
  assert.equal(isSpeechStart(0.05, floor, 0.2, 0.1), true);
  assert.ok(startThreshold(floor) > floor);
});

test("quiet coquettish cues can still start a turn", () => {
  const floor = 0.006;
  assert.equal(isSpeechStart(0.009, floor, 0.55, 0.12), true);
  assert.equal(isSpeechStart(0.009, floor, 0.1, 0.28), true);
});

test("debug VAD numbers are documented vs production", () => {
  assert.equal(START_FLOOR_MIN, 0.01);
  assert.equal(START_FLOOR_MULT, 1.95);
  assert.equal(DEBUG_START_FLOOR_MIN, 0.003);
  assert.equal(DEBUG_START_FLOOR_MULT, 1.25);
  const floor = 0.008;
  assert.equal(startThreshold(floor, false), Math.max(0.01, floor * 1.95));
  assert.equal(startThreshold(floor, true), Math.max(0.003, floor * 1.25));
});

test("debug hold never drops below max(0.005, floor*1.4)", () => {
  assert.equal(holdThreshold(0.008, true), Math.max(0.005, 0.008 * 1.4));
  assert.equal(holdThreshold(0.002, true), 0.005);
  assert.equal(holdThreshold(0.02, true), Math.max(0.005, 0.02 * 1.4));
});

test("silence after 1.5 seconds ends the turn", () => {
  assert.equal(SILENCE_MS, 1500);
  assert.equal(
    shouldEndUtterance({
      now: 3000,
      startAt: 0,
      lastVoiceAt: 1400,
      voiced: false,
      hasText: false,
      lastTextAt: 0,
    }),
    true,
  );
});

test("a one-second pause is not enough to send", () => {
  assert.equal(
    shouldEndUtterance({
      now: 2500,
      startAt: 0,
      lastVoiceAt: 1400,
      voiced: false,
      hasText: true,
      lastTextAt: 1400,
    }),
    false,
  );
});

test("silence threshold follows the 1.0 / 1.5 / 2.0 setting", () => {
  const base = {
    now: 2500,
    startAt: 0,
    lastVoiceAt: 1400,
    voiced: false,
    hasText: true,
    lastTextAt: 1400,
  };
  assert.equal(shouldEndUtterance({ ...base, silenceMs: 1000 }), true);
  assert.equal(shouldEndUtterance({ ...base, silenceMs: 1500 }), false);
  assert.equal(shouldEndUtterance({ ...base, silenceMs: 2000 }), false);
  assert.equal(
    shouldEndUtterance({
      now: 3500,
      startAt: 0,
      lastVoiceAt: 1400,
      voiced: false,
      hasText: true,
      lastTextAt: 1400,
      silenceMs: 2000,
    }),
    true,
  );
});

test("speech text going idle does not cut a live turn", () => {
  assert.equal(
    shouldEndUtterance({
      now: 8000,
      startAt: 0,
      lastVoiceAt: 8000,
      voiced: true,
      hasText: true,
      lastTextAt: 2000,
    }),
    false,
  );
});

test("stale speech text from before this turn does not end it", () => {
  assert.equal(
    shouldEndUtterance({
      now: 800,
      startAt: 500,
      lastVoiceAt: 780,
      voiced: true,
      hasText: true,
      lastTextAt: 120,
    }),
    false,
  );
});

test("a short click is not flushed as an utterance", () => {
  assert.equal(
    shouldEndUtterance({
      now: 180,
      startAt: 0,
      lastVoiceAt: 0,
      voiced: false,
      hasText: false,
      lastTextAt: 0,
    }),
    false,
  );
});

test("a long turn is not force-ended while you are still talking", () => {
  assert.equal(
    shouldEndUtterance({
      now: 30_000,
      startAt: 0,
      lastVoiceAt: 30_000,
      voiced: true,
      hasText: true,
      lastTextAt: 29_000,
    }),
    false,
  );
});

test("annotation mode waits MIN_SPEECH_MS of continuous speech before recording", () => {
  assert.equal(MIN_SPEECH_MS, 220);
  assert.equal(canBeginUtterance({ rising: true, heldMs: 100, requireHold: true }), false);
  assert.equal(canBeginUtterance({ rising: true, heldMs: 220, requireHold: true }), true);
  assert.equal(canBeginUtterance({ rising: true, heldMs: 0, requireHold: false }), true);
  assert.equal(canBeginUtterance({ rising: false, heldMs: 500, requireHold: true }), false);
});

test("Qingran tail guard is 300ms", () => {
  assert.equal(POST_QINGRAN_MS, 300);
});

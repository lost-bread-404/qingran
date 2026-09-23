import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canBeginUtterance,
  DEBUG_START_FLOOR_MIN,
  DEBUG_START_FLOOR_MULT,
  holdCountsAsSpeech,
  holdThreshold,
  isHoldVoiced,
  isSpeechStart,
  MAX_UTTERANCE_MS,
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

test("production VAD is sensitive enough for a murmur, debug is lower still", () => {
  assert.equal(START_FLOOR_MIN, 0.004);
  assert.equal(START_FLOOR_MULT, 1.35);
  assert.equal(DEBUG_START_FLOOR_MIN, 0.003);
  assert.equal(DEBUG_START_FLOOR_MULT, 1.25);
  const floor = 0.008;
  assert.equal(startThreshold(floor, false), Math.max(0.004, floor * 1.35));
  assert.equal(startThreshold(floor, true), Math.max(0.003, floor * 1.25));
  assert.ok(startThreshold(floor, false) > startThreshold(floor, true));
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
      now: 20_000,
      startAt: 0,
      lastVoiceAt: 20_000,
      voiced: true,
      hasText: true,
      lastTextAt: 19_000,
      maxUtteranceMs: 30_000,
    }),
    false,
  );
});

test("steady room noise does not hold the turn open", () => {
  const floor = 0.01;
  const rms = floor * 1.3;
  assert.equal(isHoldVoiced(rms, floor), true);
  assert.equal(
    holdCountsAsSpeech({ rms, floor, hz: 0, clarity: 0.12, clarityCut: 0.58 }),
    false,
  );
  let lastVoiceAt = 400;
  let now = 400;
  let ended = false;
  for (let i = 0; i < 60; i += 1) {
    now += 40;
    const keeps = holdCountsAsSpeech({ rms, floor, hz: 0, clarity: 0.12, clarityCut: 0.58 });
    if (
      shouldEndUtterance({
        now,
        startAt: 0,
        lastVoiceAt,
        voiced: keeps,
        hasText: true,
        lastTextAt: 400,
        silenceMs: 1500,
        maxUtteranceMs: 30_000,
      })
    ) {
      ended = true;
      break;
    }
  }
  assert.equal(ended, true);
  assert.ok(now >= 400 + 1500);
  assert.ok(now < 400 + 2000);
});

test("stable human pitch above the hold floor keeps the turn open", () => {
  const floor = 0.01;
  assert.equal(
    holdCountsAsSpeech({ rms: floor * 1.3, floor, hz: 180, clarity: 0.8, clarityCut: 0.58 }),
    true,
  );
  assert.equal(
    shouldEndUtterance({
      now: 4000,
      startAt: 0,
      lastVoiceAt: 4000,
      voiced: true,
      hasText: true,
      lastTextAt: 3900,
      maxUtteranceMs: 30_000,
    }),
    false,
  );
});

test("past the max length the turn ends even while still voiced", () => {
  assert.equal(MAX_UTTERANCE_MS, 30_000);
  assert.equal(
    shouldEndUtterance({
      now: 30_000,
      startAt: 0,
      lastVoiceAt: 30_000,
      voiced: true,
      hasText: true,
      lastTextAt: 29_000,
    }),
    true,
  );
  assert.equal(
    shouldEndUtterance({
      now: 29_000,
      startAt: 0,
      lastVoiceAt: 29_000,
      voiced: true,
      hasText: true,
      lastTextAt: 29_000,
      maxUtteranceMs: 30_000,
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

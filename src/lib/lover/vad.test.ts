import assert from "node:assert/strict";
import { test } from "node:test";
import {
  holdThreshold,
  isHoldVoiced,
  isSpeechStart,
  nextFloor,
  shouldEndUtterance,
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

test("hold uses the floor so room noise is not treated as speech", () => {
  const floor = 0.018;
  assert.equal(isHoldVoiced(0.02, floor), false);
  assert.equal(isHoldVoiced(0.04, floor), true);
  assert.ok(holdThreshold(floor) > floor);
});

test("silence after speech ends the turn", () => {
  assert.equal(
    shouldEndUtterance({
      now: 2500,
      startAt: 0,
      lastVoiceAt: 1200,
      voiced: false,
      hasText: false,
      lastTextAt: 0,
    }),
    true,
  );
});

test("stuck ambient energy still ends once speech text goes idle", () => {
  assert.equal(
    shouldEndUtterance({
      now: 2400,
      startAt: 0,
      lastVoiceAt: 2400,
      voiced: true,
      hasText: true,
      lastTextAt: 1300,
    }),
    true,
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

test("a very long turn is force-ended", () => {
  assert.equal(
    shouldEndUtterance({
      now: 12_000,
      startAt: 0,
      lastVoiceAt: 12_000,
      voiced: true,
      hasText: false,
      lastTextAt: 0,
    }),
    true,
  );
});

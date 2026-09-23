import assert from "node:assert/strict";
import { test } from "node:test";
import { utteranceToneMark, type ProsodyFrame } from "../prosody.ts";
import {
  applyNoiseGear,
  applyRecordGear,
  DEFAULT_HEARING_SENSE,
  formatSenseLine,
  lockHearingSense,
  parseSenseLine,
  previewToneReplay,
  toneFromSense,
  withNoiseFine,
  withRecordFine,
} from "./sense.ts";

const rising: ProsodyFrame[] = Array.from({ length: 12 }, (_, i) => ({
  t: i * 0.04,
  rms: 0.05,
  hz: 200 + i * 8,
  clarity: 0.9,
  centroid: 800,
  bright: 0.2,
}));

test("default sense stays the mid gear after a round trip", () => {
  const locked = lockHearingSense(DEFAULT_HEARING_SENSE);
  assert.equal(locked.recordGear, "mid");
  assert.equal(locked.noiseGear, "mid");
  assert.equal(locked.holdMin, 0.0045);
  assert.equal(locked.cueMin, 0.003);
  assert.equal(locked.endWaitMs, 1500);
  assert.equal(locked.toneOn, false);
  assert.equal(locked.riseQuestion, 1.18);
  assert.equal(locked.flatZone, 0.1);
  assert.equal(formatSenseLine(locked), "录音：中 · 等待：1.5s · 噪音：中 · 语气：关");
  assert.equal(parseSenseLine(`静音等待 1500ms\n${formatSenseLine(locked)}`), formatSenseLine(locked));
});

test("a fine edit becomes custom, and matching the preset snaps back", () => {
  const custom = withRecordFine(DEFAULT_HEARING_SENSE, { startMin: 0.02 });
  assert.equal(custom.recordGear, "custom");
  const back = withRecordFine(custom, { startMin: DEFAULT_HEARING_SENSE.startMin });
  assert.equal(back.recordGear, "mid");
  const high = applyRecordGear(custom, "high");
  assert.equal(high.recordGear, "high");
  assert.equal(high.startMin, 0.0025);
  assert.equal(high.minVoicedMs, 0);
  const loose = withNoiseFine(DEFAULT_HEARING_SENSE, { voicedMin: 0.15, noiseMinMs: 150 });
  assert.equal(loose.noiseGear, "low");
  assert.equal(applyNoiseGear(loose, "high").noiseGear, "high");
});

test("old silence and voice fields fill a profile that has no sense yet", () => {
  const locked = lockHearingSense(undefined, { endWaitMs: 800, voicedMin: 0.55, noiseMinMs: 500 });
  assert.equal(locked.endWaitMs, 800);
  assert.equal(locked.noiseGear, "high");
  assert.equal(locked.recordGear, "mid");
  assert.equal(locked.toneOn, false);
});

test("tone stays off unless the switch is on, and the flat zone blocks every mark", () => {
  assert.equal(utteranceToneMark(rising, toneFromSense(DEFAULT_HEARING_SENSE)), "");
  const wide = toneFromSense({ ...DEFAULT_HEARING_SENSE, toneOn: true, flatZone: 0.5 });
  assert.equal(utteranceToneMark(rising, wide), "");
  const on = toneFromSense({ ...DEFAULT_HEARING_SENSE, toneOn: true });
  assert.equal(utteranceToneMark(rising, on), "？");
});

test("replay scores the last labeled clips from stored prosody", () => {
  const prosody = {
    hopMs: 40,
    rms: rising.map((frame) => frame.rms),
    hz: rising.map((frame) => frame.hz),
    clarity: rising.map((frame) => frame.clarity),
    centroid: rising.map((frame) => frame.centroid),
    bright: rising.map((frame) => frame.bright),
  };
  const off = previewToneReplay(
    [
      { goldText: "在吗？", prosody },
      { goldText: "你好", prosody: null },
    ],
    DEFAULT_HEARING_SENSE,
  );
  assert.equal(off.n, 1);
  assert.equal(off.marked, 0);
  assert.equal(off.agree, 0);
  const on = previewToneReplay([{ goldText: "在吗？", prosody }], { ...DEFAULT_HEARING_SENSE, toneOn: true });
  assert.equal(on.n, 1);
  assert.equal(on.marked, 1);
  assert.equal(on.agree, 1);
  assert.equal(on.markedRate, 1);
  assert.equal(on.agreeRate, 1);
});

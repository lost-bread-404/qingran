import assert from "node:assert/strict";
import { test } from "node:test";
import { UNRECOGNIZED_TEXT, type HeardUtterance } from "./heard.ts";
import {
  HUMAN_F0_MAX_HZ,
  HUMAN_F0_MIN_HZ,
  NIGHT_MIN_MS,
  NIGHT_NOISE_TEXT,
  NIGHT_VOICED_MIN,
  applyNightVoiceGate,
  clampNightMinMs,
  clampNightVoicedRatio,
  formatClipVoiceLine,
  measureVoiceStats,
  nightIsNoise,
  nightNoiseReplyText,
  wavDurationMsFromBytes,
} from "./night-voice.ts";
import type { ProsodyFrame } from "../prosody.ts";

function frame(hz: number, clarity = 0.8, t = 0, rms = 0.02): ProsodyFrame {
  return { t, rms, hz, clarity, centroid: 400, bright: 0.1 };
}

function spread(rows: ProsodyFrame[], spanSec: number): ProsodyFrame[] {
  if (rows.length <= 1) return rows;
  return rows.map((row, index) => ({ ...row, t: (spanSec * index) / (rows.length - 1) }));
}

function timeline(totalMs: number, hopMs: number, at: (t: number) => Partial<ProsodyFrame>): ProsodyFrame[] {
  const frames: ProsodyFrame[] = [];
  for (let ms = 0; ms <= totalMs; ms += hopMs) {
    const t = ms / 1000;
    const over = at(t);
    frames.push({
      t,
      rms: over.rms ?? 0.001,
      hz: over.hz ?? 0,
      clarity: over.clarity ?? 0,
      centroid: over.centroid ?? 400,
      bright: over.bright ?? 0.1,
    });
  }
  return frames;
}

function heard(text: string, extra: Partial<HeardUtterance> = {}): HeardUtterance {
  return { text, turnId: "t", skipQingran: text === UNRECOGNIZED_TEXT, ...extra };
}

test("voiced ratio counts only stable pitch inside the human band", () => {
  const frames = spread(
    [frame(180), frame(40), frame(900), frame(0, 0), frame(200, 0.2), frame(220)],
    0.48,
  );
  const stats = measureVoiceStats(frames, 480);
  assert.equal(stats.frameCount, 6);
  assert.equal(stats.denomFrames, 6);
  assert.equal(stats.inBandFrames, 2);
  assert.equal(stats.voicedRatio, 2 / 6);
  assert.equal(stats.voicedMs, 480);
  assert.equal(stats.f0MinHz, 40);
  assert.equal(stats.f0MaxHz, 900);
  assert.equal(stats.f0InVoice, false);
  assert.equal(stats.durationMs, 480);
  assert.ok(HUMAN_F0_MIN_HZ < 180 && 180 < HUMAN_F0_MAX_HZ);
});

test("night noise is low voiced ratio or short duration, not missing words", () => {
  const voice = measureVoiceStats(spread([frame(160), frame(170), frame(180), frame(0, 0)], 0.42), 420);
  assert.equal(nightIsNoise(voice, { voicedMin: NIGHT_VOICED_MIN, minMs: NIGHT_MIN_MS }), false);
  const rustle = measureVoiceStats(spread([frame(0, 0), frame(40), frame(0, 0), frame(30, 0.2)], 0.9), 900);
  assert.equal(nightIsNoise(rustle, { voicedMin: 0.3, minMs: 300 }), true);
  const shortHmm = measureVoiceStats(spread([frame(180), frame(190)], 0.18), 180);
  assert.equal(nightIsNoise(shortHmm, { voicedMin: 0.3, minMs: 300 }), true);
  assert.equal(nightIsNoise(measureVoiceStats([], 120), { voicedMin: 0.3, minMs: 300 }), true);
  assert.equal(nightIsNoise(measureVoiceStats([], 0), { voicedMin: 0.3, minMs: 300 }), false);
});

test("voice is kept all day, even a soft 嗯 Apple missed; noise is a mark, not a filler", () => {
  const voice = measureVoiceStats(spread([frame(150), frame(160), frame(155), frame(0, 0)], 0.5), 500);
  const kept = applyNightVoiceGate(heard(UNRECOGNIZED_TEXT, { hallucinationSuspect: true, skipQingran: true }), {
    voicedMin: 0.3,
    minMs: 300,
    stats: voice,
    rawText: "谢谢观看",
  });
  assert.equal(kept.skipQingran, false);
  assert.equal(kept.nightNoise, false);
  assert.equal(kept.hallucinationSuspect, false);
  assert.equal(kept.text, "谢谢观看");

  const said = applyNightVoiceGate(heard("嗯"), {
    voicedMin: 0.3,
    minMs: 300,
    stats: voice,
    rawText: "嗯",
  });
  assert.equal(said.skipQingran, false);
  assert.equal(said.text, "嗯");

  const murmur = applyNightVoiceGate(heard(UNRECOGNIZED_TEXT, { hallucinationSuspect: true, skipQingran: true }), {
    voicedMin: 0.3,
    minMs: 300,
    stats: voice,
    rawText: "",
  });
  assert.equal(murmur.skipQingran, false);
  assert.equal(murmur.text, "嗯");

  const noise = applyNightVoiceGate(heard("啊", { hallucinationSuspect: false }), {
    voicedMin: 0.3,
    minMs: 300,
    stats: measureVoiceStats(spread([frame(0, 0), frame(40), frame(0, 0), frame(0, 0)], 0.8), 800),
  });
  assert.equal(noise.skipQingran, true);
  assert.equal(noise.nightNoise, true);
  assert.equal(noise.text, NIGHT_NOISE_TEXT);
  assert.equal(nightNoiseReplyText(noise.text), NIGHT_NOISE_TEXT);
  assert.equal(nightNoiseReplyText("在吗"), "在吗");
});

test("the pitch gate runs even when an old profile had night mode off", () => {
  const heardRow = heard("啊", { skipQingran: false });
  const noise = applyNightVoiceGate(heardRow, {
    voicedMin: 0.3,
    minMs: 300,
    stats: measureVoiceStats(spread([frame(0, 0), frame(0, 0), frame(40, 0.2)], 0.6), 600),
  });
  assert.equal(noise.nightNoise, true);
  assert.equal(noise.skipQingran, true);
  assert.equal(noise.text, NIGHT_NOISE_TEXT);
});

test("thresholds clamp and the lab line shows ratio, pitch, duration", () => {
  assert.equal(clampNightVoicedRatio(0.33), 0.35);
  assert.equal(clampNightVoicedRatio(undefined), 0.3);
  assert.equal(clampNightVoicedRatio(9), 1);
  assert.equal(clampNightMinMs(280), 300);
  assert.equal(clampNightMinMs(5000), 2000);
  assert.equal(clampNightMinMs(0), 0);
  assert.equal(
    formatClipVoiceLine({ voicedRatio: 0.416, f0MinHz: 118, f0MaxHz: 246, durationMs: 480 }),
    "人声 0.42 · 基频 118–246 Hz · 480ms",
  );
  assert.equal(
    formatClipVoiceLine({ voicedRatio: null, f0MinHz: null, f0MaxHz: null, durationMs: 180 }),
    "人声 — · 基频 — · 180ms",
  );
  assert.equal(
    formatClipVoiceLine({
      voicedRatio: 0.83,
      f0MinHz: 160,
      f0MaxHz: 190,
      durationMs: 4000,
      voicedMs: 1000,
      inBandFrames: 25,
      denomFrames: 25,
      voiceNoise: false,
    }),
    "人声 0.83 · 基频 160–190 Hz · 4000ms · 有声 1000ms · 25/25 · 说话",
  );
});

test("silence around a short utterance is not the denominator", () => {
  const speech = timeline(4000, 40, (t) =>
    t >= 1.5 && t <= 2.5 ? { rms: 0.05, hz: 180, clarity: 0.8 } : { rms: 0.001 },
  );
  const stats = measureVoiceStats(speech, 4000);
  assert.ok(stats.frameCount > stats.denomFrames);
  assert.ok(stats.inBandFrames / stats.frameCount < 0.3);
  assert.ok(stats.voicedRatio >= 0.9);
  assert.ok(stats.voicedMs >= 800 && stats.voicedMs <= 1200);
  assert.equal(nightIsNoise(stats, { voicedMin: 0.3, minMs: 300 }), false);

  const friction = timeline(2000, 40, () => ({ rms: 0.05, hz: 0, clarity: 0.2 }));
  const rustle = measureVoiceStats(friction, 2000);
  assert.ok(rustle.denomFrames > 0);
  assert.equal(rustle.inBandFrames, 0);
  assert.equal(nightIsNoise(rustle, { voicedMin: 0.3, minMs: 300 }), true);

  const hmm = timeline(200, 40, () => ({ rms: 0.03, hz: 190, clarity: 0.7 }));
  const soft = measureVoiceStats(hmm, 200);
  assert.equal(soft.continuousMs, 200);
  assert.ok(soft.voicedMs < 300);
  assert.equal(nightIsNoise(soft, { voicedMin: 0.3, minMs: 300 }), false);

  const buried = timeline(1000, 40, (t) =>
    t <= 0.2 ? { rms: 0.05, hz: 180, clarity: 0.8 } : { rms: 0.05, hz: 0, clarity: 0.1 },
  );
  const lowRatio = measureVoiceStats(buried, 1000);
  assert.ok(lowRatio.voicedRatio < 0.3);
  assert.ok(lowRatio.continuousMs >= 200);
  assert.equal(nightIsNoise(lowRatio, { voicedMin: 0.3, minMs: 300 }), false);
});

test("wav header duration does not need the sample payload", () => {
  const bytes = new Uint8Array(44);
  bytes.set([82, 73, 70, 70], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 36, true);
  bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set([100, 97, 116, 97], 36);
  view.setUint32(40, 32000, true);
  assert.equal(wavDurationMsFromBytes(bytes), 1000);
});

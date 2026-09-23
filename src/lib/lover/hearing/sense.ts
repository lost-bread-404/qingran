import { clampNightMinMs, clampNightVoicedRatio, clampPitchHoldMs, clampVoicedClarity } from "./night-voice.ts";
import { cueToneMarks } from "./metrics.ts";
import {
  DEFAULT_TONE_THRESHOLDS,
  framesFromStored,
  readTone,
  type StoredProsody,
  type ToneThresholds,
} from "../prosody.ts";
import { clampEndWaitMs } from "../vad.ts";
import type { VadCuts } from "../vad.ts";

export type SenseGear = "low" | "mid" | "high" | "custom";

export type RecordFine = VadCuts & { minVoicedMs: number };

export type HearingSense = {
  recordGear: SenseGear;
  startMin: number;
  startMult: number;
  holdMin: number;
  holdMult: number;
  cueMin: number;
  cueMult: number;
  clarityCut: number;
  brightCut: number;
  minVoicedMs: number;
  endWaitMs: number;
  noiseGear: SenseGear;
  voicedMin: number;
  noiseMinMs: number;
  /** How steady a fundamental must be before it counts as a voice. Lower lets breath and murmur through. */
  voicedClarity: number;
  /** A run of human pitch at least this long is speech even when the ratio is low. */
  pitchHoldMs: number;
  toneOn: boolean;
  riseQuestion: number;
  glideRatio: number;
  waveMinSec: number;
  fadeRatio: number;
  bangPeak: number;
  bangDur: number;
  flatZone: number;
};

export const RECORD_PRESETS: Record<Exclude<SenseGear, "custom">, RecordFine> = {
  low: {
    startMin: 0.01,
    startMult: 1.95,
    holdMin: 0.008,
    holdMult: 1.65,
    cueMin: 0.0075,
    cueMult: 1.4,
    clarityCut: 0.42,
    brightCut: 0.2,
    minVoicedMs: 180,
  },
  mid: {
    startMin: 0.004,
    startMult: 1.35,
    holdMin: 0.0045,
    holdMult: 1.25,
    cueMin: 0.003,
    cueMult: 1.12,
    clarityCut: 0.28,
    brightCut: 0.1,
    minVoicedMs: 0,
  },
  high: {
    startMin: 0.0025,
    startMult: 1.12,
    holdMin: 0.003,
    holdMult: 1.1,
    cueMin: 0.002,
    cueMult: 1.02,
    clarityCut: 0.18,
    brightCut: 0.06,
    minVoicedMs: 0,
  },
};

export const NOISE_PRESETS: Record<Exclude<SenseGear, "custom">, { voicedMin: number; noiseMinMs: number }> = {
  low: { voicedMin: 0.15, noiseMinMs: 150 },
  mid: { voicedMin: 0.3, noiseMinMs: 300 },
  high: { voicedMin: 0.55, noiseMinMs: 500 },
};

export const TONE_DEFAULTS = {
  toneOn: false,
  riseQuestion: 1.18,
  glideRatio: 0.055,
  waveMinSec: 0.42,
  fadeRatio: 0.72,
  bangPeak: 0.08,
  bangDur: 0.24,
  flatZone: 0.1,
};

/** High = more ～ marks. Not stored; the two numbers are the source of truth. */
export const WAVE_PRESETS: Record<Exclude<SenseGear, "custom">, { glideRatio: number; waveMinSec: number }> = {
  low: { glideRatio: 0.09, waveMinSec: 0.7 },
  mid: { glideRatio: TONE_DEFAULTS.glideRatio, waveMinSec: TONE_DEFAULTS.waveMinSec },
  high: { glideRatio: 0.03, waveMinSec: 0.25 },
};

/** High = more ！ marks. Not stored. */
export const BANG_PRESETS: Record<Exclude<SenseGear, "custom">, { bangPeak: number; bangDur: number }> = {
  low: { bangPeak: 0.16, bangDur: 0.12 },
  mid: { bangPeak: TONE_DEFAULTS.bangPeak, bangDur: TONE_DEFAULTS.bangDur },
  high: { bangPeak: 0.04, bangDur: 0.4 },
};

export const DEFAULT_HEARING_SENSE: HearingSense = {
  recordGear: "mid",
  ...RECORD_PRESETS.mid,
  endWaitMs: 1500,
  noiseGear: "mid",
  ...NOISE_PRESETS.mid,
  voicedClarity: 0.58,
  pitchHoldMs: 200,
  ...TONE_DEFAULTS,
};

const GEAR_LABEL: Record<SenseGear, string> = {
  low: "低",
  mid: "中",
  high: "高",
  custom: "自定义",
};

function num(value: unknown, fallback: number, min: number, max: number, step: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const stepped = Math.round((n + Number.EPSILON) / step) * step;
  const clamped = Math.min(max, Math.max(min, stepped));
  const decimals = (step.toString().split(".")[1] ?? "").length;
  const factor = 10 ** decimals;
  return Math.round((clamped + Number.EPSILON) * factor) / factor;
}

function sameFine(a: RecordFine, b: RecordFine): boolean {
  const keys = Object.keys(RECORD_PRESETS.mid) as Array<keyof RecordFine>;
  return keys.every((key) => a[key] === b[key]);
}

export function recordGearFor(fine: RecordFine): SenseGear {
  if (sameFine(fine, RECORD_PRESETS.low)) return "low";
  if (sameFine(fine, RECORD_PRESETS.mid)) return "mid";
  if (sameFine(fine, RECORD_PRESETS.high)) return "high";
  return "custom";
}

export function noiseGearFor(voicedMin: number, noiseMinMs: number): SenseGear {
  if (voicedMin === NOISE_PRESETS.low.voicedMin && noiseMinMs === NOISE_PRESETS.low.noiseMinMs) return "low";
  if (voicedMin === NOISE_PRESETS.mid.voicedMin && noiseMinMs === NOISE_PRESETS.mid.noiseMinMs) return "mid";
  if (voicedMin === NOISE_PRESETS.high.voicedMin && noiseMinMs === NOISE_PRESETS.high.noiseMinMs) return "high";
  return "custom";
}

export function lockHearingSense(
  raw: unknown,
  legacy?: { endWaitMs?: unknown; voicedMin?: unknown; noiseMinMs?: unknown },
): HearingSense {
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<HearingSense>;
  const fine: RecordFine = {
    startMin: num(src.startMin, RECORD_PRESETS.mid.startMin, 0.001, 0.05, 0.0005),
    startMult: num(src.startMult, RECORD_PRESETS.mid.startMult, 1, 3, 0.01),
    holdMin: num(src.holdMin, RECORD_PRESETS.mid.holdMin, 0.001, 0.05, 0.0005),
    holdMult: num(src.holdMult, RECORD_PRESETS.mid.holdMult, 1, 3, 0.01),
    cueMin: num(src.cueMin, RECORD_PRESETS.mid.cueMin, 0.001, 0.05, 0.0005),
    cueMult: num(src.cueMult, RECORD_PRESETS.mid.cueMult, 1, 3, 0.01),
    clarityCut: num(src.clarityCut, RECORD_PRESETS.mid.clarityCut, 0.05, 0.9, 0.01),
    brightCut: num(src.brightCut, RECORD_PRESETS.mid.brightCut, 0.02, 0.8, 0.01),
    minVoicedMs: num(src.minVoicedMs, RECORD_PRESETS.mid.minVoicedMs, 0, 800, 10),
  };
  const voicedMin = clampNightVoicedRatio(src.voicedMin ?? legacy?.voicedMin);
  const noiseMinMs = clampNightMinMs(src.noiseMinMs ?? legacy?.noiseMinMs);
  const voicedClarity = clampVoicedClarity(src.voicedClarity);
  const pitchHoldMs = clampPitchHoldMs(src.pitchHoldMs);
  const endWaitMs = clampEndWaitMs(src.endWaitMs ?? legacy?.endWaitMs);
  return {
    recordGear: recordGearFor(fine),
    ...fine,
    endWaitMs,
    noiseGear: noiseGearFor(voicedMin, noiseMinMs),
    voicedMin,
    noiseMinMs,
    voicedClarity,
    pitchHoldMs,
    toneOn: src.toneOn === true,
    riseQuestion: num(src.riseQuestion, TONE_DEFAULTS.riseQuestion, 1, 2, 0.01),
    glideRatio: num(src.glideRatio, TONE_DEFAULTS.glideRatio, 0, 0.3, 0.005),
    waveMinSec: num(src.waveMinSec, TONE_DEFAULTS.waveMinSec, 0.1, 1.5, 0.01),
    fadeRatio: num(src.fadeRatio, TONE_DEFAULTS.fadeRatio, 0.3, 1, 0.01),
    bangPeak: num(src.bangPeak, TONE_DEFAULTS.bangPeak, 0.01, 0.4, 0.01),
    bangDur: num(src.bangDur, TONE_DEFAULTS.bangDur, 0.05, 1, 0.01),
    flatZone: num(src.flatZone, TONE_DEFAULTS.flatZone, 0, 0.5, 0.01),
  };
}

export function applyRecordGear(sense: HearingSense, gear: Exclude<SenseGear, "custom">): HearingSense {
  return lockHearingSense({ ...sense, recordGear: gear, ...RECORD_PRESETS[gear] });
}

export function applyNoiseGear(sense: HearingSense, gear: Exclude<SenseGear, "custom">): HearingSense {
  return lockHearingSense({ ...sense, noiseGear: gear, ...NOISE_PRESETS[gear] });
}

export function waveGearFor(glideRatio: number, waveMinSec: number): SenseGear {
  if (glideRatio === WAVE_PRESETS.low.glideRatio && waveMinSec === WAVE_PRESETS.low.waveMinSec) return "low";
  if (glideRatio === WAVE_PRESETS.mid.glideRatio && waveMinSec === WAVE_PRESETS.mid.waveMinSec) return "mid";
  if (glideRatio === WAVE_PRESETS.high.glideRatio && waveMinSec === WAVE_PRESETS.high.waveMinSec) return "high";
  return "custom";
}

export function bangGearFor(bangPeak: number, bangDur: number): SenseGear {
  if (bangPeak === BANG_PRESETS.low.bangPeak && bangDur === BANG_PRESETS.low.bangDur) return "low";
  if (bangPeak === BANG_PRESETS.mid.bangPeak && bangDur === BANG_PRESETS.mid.bangDur) return "mid";
  if (bangPeak === BANG_PRESETS.high.bangPeak && bangDur === BANG_PRESETS.high.bangDur) return "high";
  return "custom";
}

export function applyWaveGear(sense: HearingSense, gear: Exclude<SenseGear, "custom">): HearingSense {
  return lockHearingSense({ ...sense, ...WAVE_PRESETS[gear] });
}

export function applyBangGear(sense: HearingSense, gear: Exclude<SenseGear, "custom">): HearingSense {
  return lockHearingSense({ ...sense, ...BANG_PRESETS[gear] });
}

export function withRecordFine(sense: HearingSense, patch: Partial<RecordFine>): HearingSense {
  return lockHearingSense({ ...sense, ...patch });
}

export function withNoiseFine(sense: HearingSense, patch: { voicedMin?: number; noiseMinMs?: number }): HearingSense {
  return lockHearingSense({ ...sense, ...patch });
}

export function recordCuts(sense: HearingSense): VadCuts {
  return {
    startMin: sense.startMin,
    startMult: sense.startMult,
    holdMin: sense.holdMin,
    holdMult: sense.holdMult,
    cueMin: sense.cueMin,
    cueMult: sense.cueMult,
    clarityCut: sense.clarityCut,
    brightCut: sense.brightCut,
  };
}

export function toneFromSense(sense: HearingSense): ToneThresholds {
  return {
    ...DEFAULT_TONE_THRESHOLDS,
    riseQuestion: sense.riseQuestion,
    glideRatio: sense.glideRatio,
    waveDur: sense.waveMinSec,
    fadeRatio: sense.fadeRatio,
    bangPeak: sense.bangPeak,
    bangDur: sense.bangDur,
    flatZone: sense.flatZone,
    marks: sense.toneOn,
  };
}

export function formatSenseLine(sense: HearingSense): string {
  const wait = (sense.endWaitMs / 1000).toFixed(1).replace(/\.0$/, "");
  return `录音：${GEAR_LABEL[sense.recordGear]} · 等待：${wait}s · 噪音：${GEAR_LABEL[sense.noiseGear]} · 语气：${sense.toneOn ? "开" : "关"}`;
}

export function parseSenseLine(note: string | null | undefined): string | null {
  const found = (note ?? "").match(/录音：[低中高自定义]+ · 等待：\d+(?:\.\d+)?s · 噪音：[低中高自定义]+ · 语气：[开关]/);
  return found?.[0] ?? null;
}

export function formatToneReadingLine(input: {
  toneRise?: number | null;
  toneGlide?: number | null;
  toneFade?: number | null;
  tonePeak?: number | null;
  toneMark?: string | null;
}): string {
  const n = (value: number | null | undefined, digits = 2) =>
    value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
  const mark = input.toneMark == null ? "—" : input.toneMark || "无";
  return `上扬 ${n(input.toneRise)} · 滑动 ${n(input.toneGlide)} · 衰减 ${n(input.toneFade)} · 峰值 ${n(input.tonePeak)} · 符号 ${mark}`;
}

export type ToneReplayClip = {
  goldText: string;
  hypText?: string;
  prosody?: StoredProsody | null;
};

export type ToneReplayScore = {
  n: number;
  marked: number;
  agree: number;
  markedRate: number;
  agreeRate: number;
};

export function previewToneReplay(clips: ToneReplayClip[], sense: HearingSense): ToneReplayScore {
  const th = toneFromSense({ ...sense, toneOn: true });
  let n = 0;
  let marked = 0;
  let agree = 0;
  for (const clip of clips) {
    const frames = framesFromStored(clip.prosody ?? null);
    if (!frames.length) continue;
    n += 1;
    const reading = readTone(frames, th);
    if (sense.toneOn && reading.mark) marked += 1;
    const got = sense.toneOn ? reading.mark : "";
    if (cueToneMarks(clip.goldText) === got) agree += 1;
  }
  return {
    n,
    marked,
    agree,
    markedRate: n ? marked / n : 0,
    agreeRate: n ? agree / n : 0,
  };
}

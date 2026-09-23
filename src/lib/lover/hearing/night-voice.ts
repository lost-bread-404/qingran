import { cuesFromProsody, voicedIslands, type ProsodyFrame } from "../prosody.ts";
import { UNRECOGNIZED_TEXT, type HeardUtterance } from "./heard.ts";

/** Stable pitch: same clarity cut the pitch tracker uses before it reports a frequency. */
export const VOICED_CLARITY = 0.58;
/** Adult speech. Frames outside this band do not count toward 人声占比. */
export const HUMAN_F0_MIN_HZ = 75;
export const HUMAN_F0_MAX_HZ = 500;

export const NIGHT_VOICED_MIN = 0.3;
export const NIGHT_MIN_MS = 300;
/** A run of human pitch this long is speech even when the ratio is short of the bar. */
export const PITCH_HOLD_MS = 200;
export const NIGHT_VOICED_STEP = 0.05;
export const NIGHT_MS_STEP = 50;
export const NIGHT_MS_MAX = 2000;

/** Stored on a noise turn so the clip has a mark, without pretending she said a word. */
export const NIGHT_NOISE_TEXT = "（一声响动）";

export type VoiceStats = {
  /** In-band human-pitch frames divided by frames inside energy islands. Silence is not in the denominator. */
  voicedRatio: number;
  /** Min/max of every stable fundamental inside those islands, including ones outside the human band. */
  f0MinHz: number | null;
  f0MaxHz: number | null;
  /** True when every detected fundamental sits inside the human band. */
  f0InVoice: boolean;
  /** Whole clip, including pre-roll and the wait at the end. */
  durationMs: number;
  /** Sum of energy-island lengths. Pre-roll, gaps, and the trailing wait are not included. */
  voicedMs: number;
  /** Longest run of consecutive human-band pitch inside the islands. */
  continuousMs: number;
  /** Human-band frames inside the islands. */
  inBandFrames: number;
  /** Frames inside the islands. This is the ratio's denominator. */
  denomFrames: number;
  frameCount: number;
};

export function clampNightVoicedRatio(value: unknown, fallback = NIGHT_VOICED_MIN): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const stepped = Math.round(n / NIGHT_VOICED_STEP) * NIGHT_VOICED_STEP;
  const clamped = Math.min(1, Math.max(0, stepped));
  return Math.round(clamped * 100) / 100;
}

export function clampNightMinMs(value: unknown, fallback = NIGHT_MIN_MS): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const stepped = Math.round(n / NIGHT_MS_STEP) * NIGHT_MS_STEP;
  return Math.min(NIGHT_MS_MAX, Math.max(0, stepped));
}

export function clampVoicedClarity(value: unknown, fallback = VOICED_CLARITY): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const stepped = Math.round(n * 100) / 100;
  return Math.min(0.9, Math.max(0.2, stepped));
}

export function clampPitchHoldMs(value: unknown, fallback = PITCH_HOLD_MS): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const stepped = Math.round(n / 10) * 10;
  return Math.min(NIGHT_MS_MAX, Math.max(0, stepped));
}

function isHumanPitch(frame: Pick<ProsodyFrame, "hz" | "clarity">, clarityCut: number): boolean {
  const hz = Number(frame.hz) || 0;
  const clarity = Number(frame.clarity) || 0;
  return hz >= HUMAN_F0_MIN_HZ && hz <= HUMAN_F0_MAX_HZ && clarity >= clarityCut;
}

function longestHumanRunMs(islands: ReturnType<typeof voicedIslands>, clarityCut: number): number {
  let best = 0;
  for (const island of islands) {
    let runStart: number | null = null;
    let runEnd = 0;
    const close = () => {
      if (runStart == null) return;
      best = Math.max(best, runEnd - runStart);
      runStart = null;
    };
    for (const frame of island.frames) {
      if (!isHumanPitch(frame, clarityCut)) {
        close();
        continue;
      }
      if (runStart == null) runStart = frame.t;
      runEnd = frame.t;
    }
    close();
  }
  return Math.round(best * 1000);
}

export function measureVoiceStats(
  frames: ReadonlyArray<ProsodyFrame>,
  durationMs: number,
  opts?: { clarity?: number },
): VoiceStats {
  const clarityCut = clampVoicedClarity(opts?.clarity ?? VOICED_CLARITY);
  const islands = voicedIslands(frames as ProsodyFrame[]);
  const islandFrames = islands.flatMap((island) => island.frames);
  let inBand = 0;
  let stable = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const frame of islandFrames) {
    const hz = Number(frame.hz) || 0;
    const clarity = Number(frame.clarity) || 0;
    if (hz <= 0 || clarity < clarityCut) continue;
    stable += 1;
    if (hz < min) min = hz;
    if (hz > max) max = hz;
    if (hz >= HUMAN_F0_MIN_HZ && hz <= HUMAN_F0_MAX_HZ) inBand += 1;
  }
  const denom = islandFrames.length;
  const voicedMs = Math.round(
    islands.reduce((sum, island) => sum + Math.max(0, island.end - island.start), 0) * 1000,
  );
  return {
    voicedRatio: denom ? inBand / denom : 0,
    f0MinHz: stable ? Math.round(min) : null,
    f0MaxHz: stable ? Math.round(max) : null,
    f0InVoice: stable > 0 && min >= HUMAN_F0_MIN_HZ && max <= HUMAN_F0_MAX_HZ,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    voicedMs,
    continuousMs: longestHumanRunMs(islands, clarityCut),
    inBandFrames: inBand,
    denomFrames: denom,
    frameCount: frames.length,
  };
}

/**
 * Noise is missing human pitch inside the energetic part, or that part is too short to be a word.
 * A continuous run of human pitch at least `pitchHoldMs` long is speech even when the ratio is low.
 * Loudness is not used. Silence around the words is not used.
 */
export function nightIsNoise(
  stats: VoiceStats,
  thresholds: { voicedMin: number; minMs: number; pitchHoldMs?: number },
): boolean {
  const hold = thresholds.pitchHoldMs ?? PITCH_HOLD_MS;
  if (stats.frameCount === 0) {
    return stats.durationMs > 0 && stats.durationMs < thresholds.minMs;
  }
  if (hold > 0 && stats.continuousMs >= hold) return false;
  if (stats.voicedMs < thresholds.minMs) return true;
  return stats.voicedRatio < thresholds.voicedMin;
}

export function frameSpanMs(frames: ReadonlyArray<{ t: number }>): number {
  if (frames.length < 2) return 0;
  const start = frames[0]?.t ?? 0;
  const end = frames[frames.length - 1]?.t ?? start;
  return Math.max(0, Math.round((end - start) * 1000));
}

/** Header-only read so the browser can time a clip without decoding samples. */
export function wavDurationMsFromBytes(bytes: Uint8Array): number {
  if (bytes.length < 44) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) =>
    String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return 0;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && size >= 16 && offset + 24 <= bytes.length) {
      byteRate = view.getUint32(offset + 16, true);
    } else if (id === "data") {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
    if (offset > bytes.length) break;
  }
  if (!byteRate) return 0;
  const payload = dataSize > 0 ? dataSize : Math.max(0, bytes.length - 44);
  return Math.round((payload / byteRate) * 1000);
}

export function formatClipVoiceLine(input: {
  voicedRatio: number | null;
  f0MinHz: number | null;
  f0MaxHz: number | null;
  durationMs: number | null;
  voicedMs?: number | null;
  inBandFrames?: number | null;
  denomFrames?: number | null;
  voiceNoise?: boolean | null;
}): string {
  const ratio =
    input.voicedRatio == null || !Number.isFinite(input.voicedRatio) ? "—" : input.voicedRatio.toFixed(2);
  const f0 =
    input.f0MinHz == null || input.f0MaxHz == null ? "—" : `${input.f0MinHz}–${input.f0MaxHz} Hz`;
  const dur = input.durationMs == null || !Number.isFinite(input.durationMs) ? "—" : `${Math.round(input.durationMs)}ms`;
  const base = `人声 ${ratio} · 基频 ${f0} · ${dur}`;
  const hasGate =
    input.voicedMs != null || input.inBandFrames != null || input.denomFrames != null || input.voiceNoise != null;
  if (!hasGate) return base;
  const voiced = input.voicedMs == null || !Number.isFinite(input.voicedMs) ? "—" : `${Math.round(input.voicedMs)}ms`;
  const num = input.inBandFrames == null || !Number.isFinite(input.inBandFrames) ? "—" : String(input.inBandFrames);
  const den = input.denomFrames == null || !Number.isFinite(input.denomFrames) ? "—" : String(input.denomFrames);
  const verdict = input.voiceNoise == null ? "—" : input.voiceNoise ? "噪音" : "说话";
  return `${base} · 有声 ${voiced} · ${num}/${den} · ${verdict}`;
}

function usableTranscript(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed === UNRECOGNIZED_TEXT || trimmed === NIGHT_NOISE_TEXT) return "";
  return trimmed;
}

/** Human voice keeps the real words. A soft murmur with no words stays a murmur, not a drop. */
function textForVoiceReply(heard: HeardUtterance, raw: string, frames: ProsodyFrame[]): string {
  const heardText = usableTranscript(heard.text);
  const rawText = usableTranscript(raw);
  if (heardText) return heardText;
  if (rawText) return rawText;
  const cue = cuesFromProsody(frames).trim();
  if (cue) return cue;
  return "嗯";
}

/** Asking her to answer a noise mark does not invent 嗯. A real transcript, if one was kept, is used. */
export function nightNoiseReplyText(stored: string): string {
  return usableTranscript(stored) || NIGHT_NOISE_TEXT;
}

/**
 * All day: a clip is speech or noise by pitch and length, not by loudness and not by Apple being empty.
 * Noise is stored and marked, and is not turned into a filler word.
 */
export function applyNightVoiceGate(
  heard: HeardUtterance,
  input: {
    voicedMin: number;
    minMs: number;
    pitchHoldMs?: number;
    clarity?: number;
    stats?: VoiceStats | null;
    frames?: ProsodyFrame[];
    durationMs?: number;
    rawText?: string;
  },
): HeardUtterance {
  const frames = input.frames ?? [];
  const durationHint = Math.max(0, Math.round(input.durationMs || input.stats?.durationMs || frameSpanMs(frames)));
  const clarity = input.clarity ?? VOICED_CLARITY;
  const pitchHoldMs = input.pitchHoldMs ?? PITCH_HOLD_MS;
  let stats = input.stats && input.stats.frameCount > 0 ? input.stats : null;
  if (!stats) {
    const local = measureVoiceStats(frames, durationHint || frameSpanMs(frames), { clarity });
    stats = local.frameCount > 0 ? local : { ...local, durationMs: durationHint || local.durationMs };
  }
  if (stats.frameCount === 0 && !(stats.durationMs > 0 && stats.durationMs < input.minMs)) return heard;
  if (!nightIsNoise(stats, { voicedMin: input.voicedMin, minMs: input.minMs, pitchHoldMs })) {
    return {
      ...heard,
      text: textForVoiceReply(heard, input.rawText ?? "", frames),
      skipQingran: false,
      nightNoise: false,
      hallucinationSuspect: false,
    };
  }
  return {
    ...heard,
    text: NIGHT_NOISE_TEXT,
    skipQingran: true,
    nightNoise: true,
    hallucinationSuspect: false,
  };
}

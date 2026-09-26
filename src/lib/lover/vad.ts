/**
 * Call voice detection. The same rules run in the browser (src/hooks/use-call.ts)
 * and in the iPhone shell (ios/Qingran/Qingran/NativeCall.swift, NativeVad).
 *
 * - The level is rms smoothed over LEVEL_MS, so one click does not open a turn
 *   and the gap between two syllables does not close one.
 * - The room floor falls fast and rises slowly: quicker between turns, slower
 *   inside one. Speech keeps dipping between words and pulls it back down; steady
 *   noise does not, so noise that starts mid-sentence is learned and the turn
 *   still ends.
 * - A turn opens when the level stays over the start bar for startHoldMs, and
 *   stays open while the level is over the (lower) hold bar. Both bars are a
 *   multiple of the floor with an absolute minimum, from her 听力 tier.
 * - Loudness only decides when to cut. Whether a clip was her voice or noise is
 *   decided afterwards by pitch (hearing/night-voice.ts).
 */

export const MIN_SPEECH_MS = 220;
export const SILENCE_MS = 1500;
export const END_WAIT_MIN = 800;
export const END_WAIT_MAX = 3000;
export const END_WAIT_STEP = 100;
export const LISTEN_WARMUP_MS = 380;
/** First 500ms after getUserMedia: iOS mic is often still muted/silent. */
export const CALL_START_WARMUP_MS = 500;
/** After Qingran finishes speaking, ignore VAD starts and floor updates for this long. */
export const POST_QINGRAN_MS = 300;
export const FLOOR_FREEZE_TAIL_MS = POST_QINGRAN_MS;
/** One utterance is cut and sent to recognition after this long, even if the room is still noisy. */
export const MAX_UTTERANCE_MS = 600_000;
export const MAX_UTTERANCE_MIN = 5_000;
export const MAX_UTTERANCE_MAX = 600_000;
export const MAX_UTTERANCE_STEP = 1_000;

export const LEVEL_MS = 60;
export const FLOOR_FALL_MS = 250;
/** The floor may grow by a factor of e every this many ms, never past the level itself. */
export const FLOOR_RISE_MS = 6000;
/** Between turns the room is all there is, so the floor catches up faster. */
export const FLOOR_RISE_IDLE_MS = 1500;
export const FLOOR_MIN = 0.0015;
export const FLOOR_MAX = 0.05;
export const FLOOR_START = 0.006;
/** A start must hold at least this long. The pre-roll keeps the sound before it. */
export const START_HOLD_MS = 80;

export type VadCuts = {
  startMin: number;
  startMult: number;
  holdMin: number;
  holdMult: number;
  /** 最短有声: a start must hold this long when it is longer than START_HOLD_MS. */
  minVoicedMs: number;
};

export function clampEndWaitMs(value: unknown, fallback = SILENCE_MS): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const stepped = Math.round(n / END_WAIT_STEP) * END_WAIT_STEP;
  return Math.min(END_WAIT_MAX, Math.max(END_WAIT_MIN, stepped));
}

export function clampMaxUtteranceMs(value: unknown, fallback = MAX_UTTERANCE_MS): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const stepped = Math.round(n / MAX_UTTERANCE_STEP) * MAX_UTTERANCE_STEP;
  return Math.min(MAX_UTTERANCE_MAX, Math.max(MAX_UTTERANCE_MIN, stepped));
}

export function shouldTrackNoiseFloor(input: {
  qingranSpeaking: boolean;
  quietForMs: number;
  tailMs?: number;
}): boolean {
  if (input.qingranSpeaking) return false;
  return input.quietForMs >= (input.tailMs ?? FLOOR_FREEZE_TAIL_MS);
}

/** Playback itself, not the React "speaking" flag: the flag lands a frame late and one loud frame slams the floor. */
export function floorUpdateAllowed(input: {
  playbackActive: boolean;
  msSincePlayback: number;
  qingranStatusSpeaking: boolean;
  msSinceStatusQuiet: number;
  tailMs?: number;
}): boolean {
  return shouldTrackNoiseFloor({
    qingranSpeaking: input.playbackActive || input.qingranStatusSpeaking,
    quietForMs: Math.min(input.msSincePlayback, input.msSinceStatusQuiet),
    tailMs: input.tailMs,
  });
}

export function smoothLevel(prev: number, rms: number, dtMs: number): number {
  const level = Number.isFinite(rms) ? Math.max(0, rms) : 0;
  const base = Number.isFinite(prev) && prev > 0 ? prev : level;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / LEVEL_MS);
  return base + (level - base) * k;
}

export function nextFloor(floor: number, level: number, dtMs: number, inTurn: boolean): number {
  const f = Number.isFinite(floor) && floor > 0 ? floor : FLOOR_START;
  const dt = Math.max(0, dtMs);
  const rise = inTurn ? FLOOR_RISE_MS : FLOOR_RISE_IDLE_MS;
  const next =
    level <= f
      ? f + (level - f) * (1 - Math.exp(-dt / FLOOR_FALL_MS))
      : Math.min(level, f * Math.exp(dt / rise));
  return Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, next));
}

export function startBar(floor: number, cuts: VadCuts): number {
  return Math.max(cuts.startMin, floor * cuts.startMult);
}

export function holdBar(floor: number, cuts: VadCuts): number {
  return Math.max(cuts.holdMin, floor * cuts.holdMult);
}

export function startHoldMs(cuts: VadCuts): number {
  return Math.max(START_HOLD_MS, cuts.minVoicedMs || 0);
}

export type EndpointInput = {
  now: number;
  startAt: number;
  lastVoiceAt: number;
  voiced: boolean;
  silenceMs?: number;
  maxUtteranceMs?: number;
};

export function shouldEndUtterance(input: EndpointInput) {
  const spoken = input.now - input.startAt;
  const cap = clampMaxUtteranceMs(input.maxUtteranceMs, MAX_UTTERANCE_MS);
  if (spoken >= cap) return true;
  if (spoken < MIN_SPEECH_MS) return false;
  if (input.voiced) return false;
  const silence = clampEndWaitMs(input.silenceMs, SILENCE_MS);
  return input.now - input.lastVoiceAt >= silence;
}

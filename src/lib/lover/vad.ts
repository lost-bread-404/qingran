import { HUMAN_F0_MAX_HZ, HUMAN_F0_MIN_HZ } from "./hearing/night-voice.ts";

export const MIN_SPEECH_MS = 220;
export const SILENCE_MS = 1500;
export const END_WAIT_MIN = 800;
export const END_WAIT_MAX = 3000;
export const END_WAIT_STEP = 100;
export const SILENCE_MS_OPTIONS = [1000, 1500, 2000] as const;
export type SilenceMs = (typeof SILENCE_MS_OPTIONS)[number];
export const VOICE_SPIKE_MS = 80;
export const LISTEN_WARMUP_MS = 380;
/** First 500ms after getUserMedia: iOS mic is often still muted/silent. */
export const CALL_START_WARMUP_MS = 500;
/** After Qingran finishes speaking, ignore VAD starts and floor updates for this long. */
export const POST_QINGRAN_MS = 300;
export const FLOOR_FREEZE_TAIL_MS = POST_QINGRAN_MS;
/** Noise floor is not allowed to climb past this. Lower floors still fall. */
export const NOISE_FLOOR_CAP = 0.02;

export function clampNoiseFloorCap(value: unknown, fallback = NOISE_FLOOR_CAP): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const stepped = Math.round(n * 1000) / 1000;
  return Math.min(0.045, Math.max(0.006, stepped));
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

/** Production start: low enough for a murmur. Noise is rejected later by voiced ratio, not by loudness. */
export const START_FLOOR_MIN = 0.004;
export const START_FLOOR_MULT = 1.35;
export const START_CUE_MIN = 0.003;
export const START_CUE_MULT = 1.12;
export const HOLD_FLOOR_MIN = 0.0045;
export const HOLD_FLOOR_MULT = 1.25;
/** One utterance is cut and sent to recognition after this long, even if the room is still noisy. */
export const MAX_UTTERANCE_MS = 600_000;
export const MAX_UTTERANCE_MIN = 5_000;
export const MAX_UTTERANCE_MAX = 600_000;
export const MAX_UTTERANCE_STEP = 1_000;

export const DEBUG_START_FLOOR_MIN = 0.003;
export const DEBUG_START_FLOOR_MULT = 1.25;
export const DEBUG_START_CUE_MIN = 0.0025;
export const DEBUG_START_CUE_MULT = 1.05;
export const DEBUG_HOLD_FLOOR_MIN = 0.005;
export const DEBUG_HOLD_FLOOR_MULT = 1.4;

export function isSilenceMs(value: unknown): value is SilenceMs {
  return value === 1000 || value === 1500 || value === 2000;
}

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

export type VadCuts = {
  startMin: number;
  startMult: number;
  holdMin: number;
  holdMult: number;
  cueMin: number;
  cueMult: number;
  clarityCut: number;
  brightCut: number;
};

export function clampFloor(value: number) {
  return Math.min(0.045, Math.max(0.004, value));
}

export function nextFloor(floor: number, rms: number, speaking: boolean, cap = NOISE_FLOOR_CAP) {
  const limit = clampNoiseFloorCap(cap);
  const next = !speaking
    ? clampFloor(floor * 0.94 + rms * 0.06)
    : rms < floor * 1.2
      ? clampFloor(floor * 0.88 + rms * 0.12)
      : floor;
  if (next > floor && next > limit) return Math.min(Math.max(floor, limit), next);
  return next;
}

export function startThreshold(floor: number, debug = false, cuts?: VadCuts | null) {
  if (cuts) return Math.max(cuts.startMin, floor * cuts.startMult);
  if (debug) return Math.max(DEBUG_START_FLOOR_MIN, floor * DEBUG_START_FLOOR_MULT);
  return Math.max(START_FLOOR_MIN, floor * START_FLOOR_MULT);
}

export function holdThreshold(floor: number, debug = false, cuts?: VadCuts | null) {
  if (cuts) return Math.max(cuts.holdMin, floor * cuts.holdMult);
  if (debug) return Math.max(DEBUG_HOLD_FLOOR_MIN, floor * DEBUG_HOLD_FLOOR_MULT);
  return Math.max(HOLD_FLOOR_MIN, floor * HOLD_FLOOR_MULT);
}

export function isSpeechStart(
  rms: number,
  floor: number,
  clarity: number,
  bright: number,
  debug = false,
  cuts?: VadCuts | null,
) {
  if (rms > startThreshold(floor, debug, cuts)) return true;
  const cue = cuts
    ? Math.max(cuts.cueMin, floor * cuts.cueMult)
    : debug
      ? Math.max(DEBUG_START_CUE_MIN, floor * DEBUG_START_CUE_MULT)
      : Math.max(START_CUE_MIN, floor * START_CUE_MULT);
  const clarityCut = cuts ? cuts.clarityCut : debug ? 0.22 : 0.28;
  const brightCut = cuts ? cuts.brightCut : debug ? 0.08 : 0.1;
  return rms > cue && (clarity >= clarityCut || bright >= brightCut);
}

export function isHoldVoiced(rms: number, floor: number, debug = false, cuts?: VadCuts | null) {
  return rms > holdThreshold(floor, debug, cuts);
}

/** Loud enough, and a stable fundamental inside the human band. Noise fails the second half. */
export function isStableHumanPitch(hz: number, clarity: number, clarityCut: number): boolean {
  return hz >= HUMAN_F0_MIN_HZ && hz <= HUMAN_F0_MAX_HZ && clarity >= clarityCut;
}

export function holdCountsAsSpeech(input: {
  rms: number;
  floor: number;
  hz: number;
  clarity: number;
  clarityCut: number;
  debug?: boolean;
  cuts?: VadCuts | null;
}): boolean {
  if (!isHoldVoiced(input.rms, input.floor, input.debug ?? false, input.cuts)) return false;
  return isStableHumanPitch(input.hz, input.clarity, input.clarityCut);
}

/** Annotation mode keeps the lowered start threshold but needs a held burst before recording. */
export function canBeginUtterance(input: {
  rising: boolean;
  heldMs: number;
  requireHold: boolean;
  minMs?: number;
}): boolean {
  if (!input.rising) return false;
  if (!input.requireHold) return true;
  return input.heldMs >= (input.minMs ?? MIN_SPEECH_MS);
}

export type EndpointInput = {
  now: number;
  startAt: number;
  lastVoiceAt: number;
  voiced: boolean;
  hasText: boolean;
  lastTextAt: number;
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

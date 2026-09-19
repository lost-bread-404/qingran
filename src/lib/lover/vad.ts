export const MIN_SPEECH_MS = 220;
export const SILENCE_MS = 2000;
export const VOICE_SPIKE_MS = 80;
export const LISTEN_WARMUP_MS = 380;

/** Production VAD start: max(0.01, floor * 1.95). Debug lowers both floor min and multiplier. */
export const START_FLOOR_MIN = 0.01;
export const START_FLOOR_MULT = 1.95;
export const START_CUE_MIN = 0.0075;
export const START_CUE_MULT = 1.4;
export const HOLD_FLOOR_MIN = 0.008;
export const HOLD_FLOOR_MULT = 1.65;

export const DEBUG_START_FLOOR_MIN = 0.003;
export const DEBUG_START_FLOOR_MULT = 1.25;
export const DEBUG_START_CUE_MIN = 0.0025;
export const DEBUG_START_CUE_MULT = 1.05;
export const DEBUG_HOLD_FLOOR_MIN = 0.005;
export const DEBUG_HOLD_FLOOR_MULT = 1.4;

export function clampFloor(value: number) {
  return Math.min(0.045, Math.max(0.004, value));
}

export function nextFloor(floor: number, rms: number, speaking: boolean) {
  if (!speaking) return clampFloor(floor * 0.94 + rms * 0.06);
  if (rms < floor * 1.2) return clampFloor(floor * 0.88 + rms * 0.12);
  return floor;
}

export function startThreshold(floor: number, debug = false) {
  if (debug) return Math.max(DEBUG_START_FLOOR_MIN, floor * DEBUG_START_FLOOR_MULT);
  return Math.max(START_FLOOR_MIN, floor * START_FLOOR_MULT);
}

export function holdThreshold(floor: number, debug = false) {
  if (debug) return Math.max(DEBUG_HOLD_FLOOR_MIN, floor * DEBUG_HOLD_FLOOR_MULT);
  return Math.max(HOLD_FLOOR_MIN, floor * HOLD_FLOOR_MULT);
}

export function isSpeechStart(
  rms: number,
  floor: number,
  clarity: number,
  bright: number,
  debug = false,
) {
  if (rms > startThreshold(floor, debug)) return true;
  const cue = debug
    ? Math.max(DEBUG_START_CUE_MIN, floor * DEBUG_START_CUE_MULT)
    : Math.max(START_CUE_MIN, floor * START_CUE_MULT);
  const clarityCut = debug ? 0.22 : 0.42;
  const brightCut = debug ? 0.08 : 0.2;
  return rms > cue && (clarity >= clarityCut || bright >= brightCut);
}

export function isHoldVoiced(rms: number, floor: number, debug = false) {
  return rms > holdThreshold(floor, debug);
}

export type EndpointInput = {
  now: number;
  startAt: number;
  lastVoiceAt: number;
  voiced: boolean;
  hasText: boolean;
  lastTextAt: number;
};

export function shouldEndUtterance(input: EndpointInput) {
  const spoken = input.now - input.startAt;
  if (spoken < MIN_SPEECH_MS) return false;
  if (input.voiced) return false;
  return input.now - input.lastVoiceAt >= SILENCE_MS;
}

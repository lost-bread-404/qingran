export const MIN_SPEECH_MS = 220;
export const SILENCE_MS = 1200;
export const TEXT_SILENCE_MS = 1000;
export const MAX_UTTER_MS = 10_000;
export const VOICE_SPIKE_MS = 80;
export const LISTEN_WARMUP_MS = 380;

export function clampFloor(value: number) {
  return Math.min(0.045, Math.max(0.004, value));
}

export function nextFloor(floor: number, rms: number, speaking: boolean) {
  if (!speaking) return clampFloor(floor * 0.94 + rms * 0.06);
  if (rms < floor * 1.2) return clampFloor(floor * 0.88 + rms * 0.12);
  return floor;
}

export function startThreshold(floor: number) {
  return Math.max(0.01, floor * 1.95);
}

export function holdThreshold(floor: number) {
  return Math.max(0.008, floor * 1.65);
}

export function isSpeechStart(rms: number, floor: number, clarity: number, bright: number) {
  if (rms > startThreshold(floor)) return true;
  const cue = Math.max(0.0075, floor * 1.4);
  return rms > cue && (clarity >= 0.42 || bright >= 0.2);
}

export function isHoldVoiced(rms: number, floor: number) {
  return rms > holdThreshold(floor);
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
  if (spoken >= MAX_UTTER_MS) return true;
  if (spoken < MIN_SPEECH_MS) return false;
  if (input.hasText && input.lastTextAt >= input.startAt && input.now - input.lastTextAt >= TEXT_SILENCE_MS) return true;
  if (input.voiced) return false;
  return input.now - input.lastVoiceAt >= (input.hasText ? TEXT_SILENCE_MS : SILENCE_MS);
}

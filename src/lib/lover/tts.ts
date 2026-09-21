import { VOICE_IO } from "./brain/config.ts";

export const TTS_SPEED_NORMAL = 1;
export const TTS_SPEED_SOFT = 0.92;

export const TTS_VOICE_RATES = [
  { id: "normal", label: "1.0", speed: 1 },
  { id: "soft", label: "0.92", speed: 0.92 },
  { id: "slow", label: "0.85", speed: 0.85 },
  { id: "brisk", label: "1.12", speed: 1.12 },
] as const;

export type VoiceRateId = (typeof TTS_VOICE_RATES)[number]["id"];

export function snapVoiceRate(speed: number) {
  let best: (typeof TTS_VOICE_RATES)[number] = TTS_VOICE_RATES[0];
  let dist = Number.POSITIVE_INFINITY;
  for (const rate of TTS_VOICE_RATES) {
    const d = Math.abs(rate.speed - speed);
    if (d < dist) {
      dist = d;
      best = rate;
    }
  }
  return best;
}

export function nextVoiceRate(speed: number) {
  const current = snapVoiceRate(speed);
  const index = TTS_VOICE_RATES.findIndex((rate) => rate.id === current.id);
  return TTS_VOICE_RATES[(index + 1) % TTS_VOICE_RATES.length]!;
}

export function ttsSpeed(speed: number) {
  return snapVoiceRate(speed).speed;
}

export function ttsRequestBody(text: string, language = VOICE_IO.language, speed = TTS_SPEED_NORMAL) {
  return {
    text,
    voice_id: VOICE_IO.voice,
    language,
    speed: clampSpeed(speed),
    text_normalization: true,
    output_format: {
      codec: VOICE_IO.codec,
      sample_rate: VOICE_IO.sampleRate,
    },
  };
}

export function shouldFlushSpoken(text: string, first: boolean): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[。！？!?]\s*$/.test(text) && t.length >= 2) return true;
  if (/[…]\s*$/.test(text) && t.length >= (first ? 4 : 6)) return true;
  if (first && t.length >= 18) return true;
  if (!first && t.length >= 72) return true;
  return false;
}

function clampSpeed(speed: number) {
  if (!Number.isFinite(speed)) return TTS_SPEED_NORMAL;
  return Math.min(1.5, Math.max(0.7, speed));
}

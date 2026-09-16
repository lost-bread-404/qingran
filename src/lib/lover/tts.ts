import { VOICE_IO } from "./brain/config.ts";

export const TTS_SPEED_NORMAL = 1;
export const TTS_SPEED_SOFT = 0.7;

export function ttsSpeed(soft: boolean) {
  return soft ? TTS_SPEED_SOFT : TTS_SPEED_NORMAL;
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

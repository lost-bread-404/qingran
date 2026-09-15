export function ttsRequestBody(text: string, language: string) {
  return {
    text,
    voice_id: "eve",
    language,
    speed: 1,
    text_normalization: true,
    output_format: {
      codec: "pcm",
      sample_rate: 24000,
    },
  };
}

export function shouldSendDelta(text: string, first: boolean): boolean {
  if (!text.trim()) return false;
  if (/[。！？!?]\s*$/.test(text) && text.trim().length >= (first ? 4 : 6)) return true;
  if (/[…]\s*$/.test(text) && text.trim().length >= (first ? 8 : 10)) return true;
  if (text.length >= 96) return true;
  return false;
}

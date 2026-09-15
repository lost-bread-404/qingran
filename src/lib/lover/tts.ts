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

export function shouldFlushSpoken(text: string, first: boolean): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[。！？!?]\s*$/.test(text) && t.length >= 2) return true;
  if (/[…]\s*$/.test(text) && t.length >= (first ? 4 : 6)) return true;
  if (first && t.length >= 18) return true;
  if (!first && t.length >= 72) return true;
  return false;
}

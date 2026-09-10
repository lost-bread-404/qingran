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

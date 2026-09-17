import { blobToBase64 } from "./audio";
import { transcribeVoice } from "./server";
import { finishHeard } from "./stt-text";
import type { ProsodyFrame } from "./prosody";
import { QUOTA_HINT, isQuotaHint } from "./xai-error";

type SttWord = { text?: string; start?: number; end?: number };

export async function hearUtterance(input: {
  wav: Blob | null;
  fallback?: Blob | null;
  liveText: string;
  frames: ProsodyFrame[];
  prompt?: string;
}) {
  const clip = input.wav && input.wav.size >= 80 ? input.wav : input.fallback && input.fallback.size >= 40 ? input.fallback : null;
  if (!clip) return finishHeard("", input.liveText, undefined, input.frames);

  let text = "";
  let words: SttWord[] = [];
  try {
    const result = await transcribeVoice({
      data: {
        audioBase64: await blobToBase64(clip),
        mimeType: clip.type || "audio/wav",
        prompt: input.prompt,
      },
    });
    if (result.ok) {
      text = result.text.trim();
      words = result.words ?? [];
    } else if (isQuotaHint(result.error)) {
      throw new Error(QUOTA_HINT);
    }
  } catch (err) {
    if (err instanceof Error && isQuotaHint(err.message)) throw err;
  }
  return finishHeard(text, input.liveText, words, input.frames);
}

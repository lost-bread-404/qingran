import { blobToBase64 } from "./audio";
import { runHearing } from "./hearing/store";
import { getHearingSession, setHearingSession } from "./hearing/session";
import { transcribeVoice } from "./server";
import { finishHeard } from "./stt-text";
import type { ProsodyFrame } from "./prosody";
import { QUOTA_HINT, isQuotaHint } from "./xai-error";
import { newId } from "./storage";
import type { HearingProviderId } from "./hearing/config";

type SttWord = { text?: string; start?: number; end?: number };

export async function hearUtterance(input: {
  wav: Blob | null;
  fallback?: Blob | null;
  liveText: string;
  frames: ProsodyFrame[];
  prompt?: string;
  speech_start?: number;
  endpoint_fired?: number;
}) {
  const clip =
    input.wav && input.wav.size >= 80
      ? input.wav
      : input.fallback && input.fallback.size >= 40
        ? input.fallback
        : null;
  if (!clip) return finishHeard("", input.liveText, undefined, input.frames);

  const session = getHearingSession();
  const turnId = newId();
  setHearingSession({ turnId, lastTurnId: turnId });
  const upload_start = Date.now();
  const audioBase64 = await blobToBase64(clip);
  const mimeType = clip.type || "audio/wav";
  const provider: HearingProviderId = session.provider;

  try {
    const result = await runHearing({
      data: {
        audioBase64,
        mimeType,
        liveText: input.liveText,
        prompt: input.prompt,
        provider,
        capture: session.capture || session.scripted,
        source: session.source,
        category: session.category ?? undefined,
        turnId,
        speech_start: input.speech_start,
        endpoint_fired: input.endpoint_fired,
        upload_start,
      },
    });
    if (result.quota) throw new Error(QUOTA_HINT);
    if (result.noise_only) return "";
    if (result.provider !== "xai" && result.tagged) return result.tagged;
    return finishHeard(result.xaiText, input.liveText, result.words, input.frames);
  } catch (err) {
    if (err instanceof Error && isQuotaHint(err.message)) throw err;
  }

  let text = "";
  let words: SttWord[] = [];
  try {
    const result = await transcribeVoice({
      data: { audioBase64, mimeType, prompt: input.prompt },
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

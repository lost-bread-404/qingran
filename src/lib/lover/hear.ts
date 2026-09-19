import { blobToBase64 } from "./audio";
import { runHearing, type RunHearingOutput } from "./hearing/store";
import { getHearingSession, setHearingSession } from "./hearing/session";
import { shouldDropAsNoise } from "./hearing/noise";
import { persistHearingClip } from "./hearing/scripted";
import { transcribeVoice } from "./server";
import { finishHeard } from "./stt-text";
import type { ProsodyFrame } from "./prosody";
import { QUOTA_HINT, isQuotaHint } from "./xai-error";
import { newId } from "./storage";
import type { HearingProviderId } from "./hearing/config";

type SttWord = { text?: string; start?: number; end?: number };

export type HearUtteranceResult = {
  text: string;
  clipId?: string;
  saveError?: string;
  xaiText: string;
};

export async function hearUtterance(input: {
  wav: Blob | null;
  fallback?: Blob | null;
  liveText: string;
  frames: ProsodyFrame[];
  prompt?: string;
  speech_start?: number;
  endpoint_fired?: number;
}): Promise<HearUtteranceResult> {
  const clip =
    input.wav && input.wav.size >= 80
      ? input.wav
      : input.fallback && input.fallback.size >= 40
        ? input.fallback
        : null;
  if (!clip) {
    return {
      text: finishHeard("", input.liveText, undefined, input.frames),
      xaiText: "",
    };
  }

  const session = getHearingSession();
  const persist = persistHearingClip(session);
  const result = await runHearingOnClip({
    clip,
    liveText: input.liveText,
    prompt: input.prompt,
    speech_start: input.speech_start,
    endpoint_fired: input.endpoint_fired,
    capture: persist,
    source: session.source,
    category: session.category ?? undefined,
  });
  setHearingSession({
    lastClipId: result.clipId ?? null,
    lastSaveError: result.saveError ?? null,
    lastXaiText: result.xaiText || null,
  });
  if (session.scripted) {
    return {
      text: result.tagged || result.xaiText || "",
      clipId: result.clipId,
      saveError: result.saveError,
      xaiText: result.xaiText,
    };
  }
  if (shouldDropAsNoise(result.noise_only, result.xaiText)) {
    return { text: "", clipId: result.clipId, saveError: result.saveError, xaiText: result.xaiText };
  }
  if (result.provider !== "xai" && result.tagged) {
    return { text: result.tagged, clipId: result.clipId, saveError: result.saveError, xaiText: result.xaiText };
  }
  return {
    text: finishHeard(result.xaiText, input.liveText, result.words, input.frames),
    clipId: result.clipId,
    saveError: result.saveError,
    xaiText: result.xaiText,
  };
}

export async function runHearingOnClip(input: {
  clip: Blob;
  liveText: string;
  prompt?: string;
  speech_start?: number;
  endpoint_fired?: number;
  capture: boolean;
  source: "real" | "scripted";
  category?: string;
}): Promise<RunHearingOutput> {
  const session = getHearingSession();
  const turnId = newId();
  setHearingSession({ turnId, lastTurnId: turnId, lastSaveError: null, lastClipId: null });
  const upload_start = Date.now();
  const audioBase64 = await blobToBase64(input.clip);
  const mimeType = input.clip.type || "audio/wav";
  const provider: HearingProviderId = session.provider;

  try {
    const result = await runHearing({
      data: {
        audioBase64,
        mimeType,
        liveText: input.liveText,
        prompt: input.prompt,
        provider,
        capture: input.capture,
        source: input.source,
        category: input.category,
        turnId,
        speech_start: input.speech_start,
        endpoint_fired: input.endpoint_fired,
        upload_start,
        context: session.context || undefined,
        nbest: session.nbest,
        extraKeyterms: session.extraKeyterms,
        debugHearing: session.debugHearing,
        mode: session.mode,
        audioRoute: session.audioRoute,
      },
    });
    if (result.quota) throw new Error(QUOTA_HINT);
    setHearingSession({
      lastClipId: result.clipId ?? null,
      lastSaveError: result.saveError ?? null,
      lastXaiText: result.xaiText || null,
    });
    return result;
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
  return {
    ok: true,
    turnId,
    provider,
    model: "",
    tagged: finishHeard(text, input.liveText, words, []),
    text,
    xaiText: text,
    liveText: input.liveText,
    noise_only: false,
    disagreement: false,
    fallback: true,
    fallback_reason: "xai-direct",
    refusal: false,
    latency_ms: 0,
    words,
    hearing: null,
  };
}

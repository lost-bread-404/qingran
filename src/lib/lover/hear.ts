import { blobToBase64 } from "./audio";
import { runHearing } from "./hearing/store";
import { getHearingSession, setHearingSession } from "./hearing/session";
import { transcribeVoice } from "./server";
import { finishHeard } from "./stt-text";
import type { ProsodyFrame } from "./prosody";
import { QUOTA_HINT, isQuotaHint } from "./xai-error";
import { newId } from "./storage";
import type { HearingProviderId } from "./hearing/config";
import {
  clipSaveBanner,
  heardFromHearing,
  type HeardUtterance,
  UNRECOGNIZED_TEXT,
  voiceTurnIdForMessage,
} from "./hearing/heard";

export { UNRECOGNIZED_TEXT, clipSaveBanner, voiceTurnIdForMessage };
export type { HeardUtterance };

type SttWord = { text?: string; start?: number; end?: number };

export async function hearUtterance(input: {
  wav: Blob | null;
  fallback?: Blob | null;
  liveText: string;
  frames: ProsodyFrame[];
  prompt?: string;
  speech_start?: number;
  endpoint_fired?: number;
}): Promise<HeardUtterance> {
  const session = getHearingSession();
  const turnId = newId();
  setHearingSession({ turnId, lastTurnId: turnId });
  const debugHearing = session.debugHearing;
  const clip =
    input.wav && input.wav.size >= 80
      ? input.wav
      : input.fallback && input.fallback.size >= 40
        ? input.fallback
        : null;
  if (!clip) {
    return {
      text: debugHearing ? UNRECOGNIZED_TEXT : "",
      turnId,
      saveError: debugHearing ? "没有录到声音。" : undefined,
      skipQingran: debugHearing,
    };
  }

  const upload_start = Date.now();
  const audioBase64 = await blobToBase64(clip);
  const mimeType = clip.type || "audio/wav";
  const provider: HearingProviderId = session.provider;
  const persist = debugHearing || session.capture;

  try {
    const result = await runHearing({
      data: {
        audioBase64,
        mimeType,
        liveText: input.liveText,
        prompt: input.prompt,
        provider,
        capture: persist,
        source: "real",
        turnId,
        speech_start: input.speech_start,
        endpoint_fired: input.endpoint_fired,
        upload_start,
        context: session.context || undefined,
        nbest: session.nbest,
        extraKeyterms: session.extraKeyterms,
        debugHearing,
        mode: session.mode,
        audioRoute: session.audioRoute,
      },
    });
    if (result.quota) throw new Error(QUOTA_HINT);
    const tagged =
      result.provider !== "xai" && result.tagged
        ? result.tagged
        : finishHeard(result.xaiText, input.liveText, result.words, input.frames, audioStats(input.frames));
    return heardFromHearing({
      debugHearing,
      turnId,
      tagged,
      xaiText: result.xaiText,
      noiseOnly: result.noise_only,
      clipId: result.clipId,
      saveError: result.saveError,
    });
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
  const finished = finishHeard(text, input.liveText, words, input.frames, audioStats(input.frames));
  return heardFromHearing({
    debugHearing,
    turnId,
    tagged: finished,
    xaiText: text,
    noiseOnly: !finished,
  });
}

function audioStats(frames: ProsodyFrame[]) {
  const durationSec = frames.at(-1)?.t ?? 0;
  const peakRms = frames.reduce((max, frame) => Math.max(max, frame.rms), 0);
  return { durationSec, peakRms };
}
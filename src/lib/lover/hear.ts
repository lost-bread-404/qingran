import { blobToBase64 } from "./audio";
import { runHearing } from "./hearing/store";
import { getHearingSession, setHearingSession } from "./hearing/session";
import { transcribeVoice } from "./server";
import { finishHeard, scrubHallucination } from "./stt-text";
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
import { applyUtteranceTag, predictUtteranceTags, stripAcousticTags } from "./hearing/tags.ts";

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
  peakRms?: number;
  vadFloor?: number;
  hearToTriggerMs?: number;
  prerollPeakRms?: number;
  holdToTalk?: boolean;
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
  let ranHearing = false;
  const predictedFromFrames = predictUtteranceTags({ frames: input.frames });

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
        peakRms: input.peakRms,
        vadFloor: input.vadFloor,
        hearToTriggerMs: input.hearToTriggerMs,
        prerollPeakRms: input.prerollPeakRms,
        liveTextSource: input.liveText.trim() ? "webspeech" : "none",
        predictedTags: predictedFromFrames,
        contextBefore: session.contextBefore,
        systemPrompt: session.systemPrompt || input.prompt,
        holdToTalk: Boolean(input.holdToTalk),
      },
    });
    ranHearing = true;
    if (result.quota) throw new Error(QUOTA_HINT);
    const predicted = result.predictedTags ?? predictedFromFrames;
    if (result.hallucinationSuspect) {
      return heardFromHearing({
        debugHearing,
        turnId,
        tagged: "",
        xaiText: result.xaiText,
        noiseOnly: result.noise_only,
        clipId: result.clipId,
        saveError: result.saveError,
        endpointFired: input.endpoint_fired,
        sttDoneAt: Date.now(),
        predictedTags: predicted,
        hallucinationSuspect: true,
        hallucinationReason: result.hallucinationReason,
      });
    }
    const core =
      result.provider !== "xai" && result.tagged
        ? stripAcousticTags(result.tagged).trim() || finishHeard(result.xaiText, input.liveText, result.words, input.frames, audioStats(input.frames), { holdToTalk: input.holdToTalk })
        : finishHeard(result.xaiText, input.liveText, result.words, input.frames, audioStats(input.frames), { holdToTalk: input.holdToTalk });
    const tagged = core ? applyUtteranceTag(core, predicted) : "";
    return heardFromHearing({
      debugHearing,
      turnId,
      tagged,
      xaiText: result.xaiText,
      noiseOnly: result.noise_only,
      clipId: result.clipId,
      saveError: result.saveError,
      endpointFired: input.endpoint_fired,
      sttDoneAt: Date.now(),
      predictedTags: predicted,
    });
  } catch (err) {
    if (err instanceof Error && isQuotaHint(err.message)) throw err;
  }

  if (ranHearing || provider === "xai") {
    return heardFromHearing({
      debugHearing,
      turnId,
      tagged: "",
      xaiText: "",
      noiseOnly: true,
      endpointFired: input.endpoint_fired,
      sttDoneAt: Date.now(),
      predictedTags: predictedFromFrames,
    });
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
  const stats = audioStats(input.frames);
  const finished = finishHeard(text, input.liveText, words, input.frames, stats, {
    holdToTalk: input.holdToTalk,
  });
  const tagged = finished ? applyUtteranceTag(finished, predictedFromFrames) : "";
  const scrubbed = scrubHallucination(text, stats, input.liveText, { holdToTalk: input.holdToTalk });
  return heardFromHearing({
    debugHearing,
    turnId,
    tagged,
    xaiText: text,
    noiseOnly: !finished,
    endpointFired: input.endpoint_fired,
    sttDoneAt: Date.now(),
    predictedTags: predictedFromFrames,
    hallucinationSuspect: scrubbed.suspect,
    hallucinationReason:
      scrubbed.reason === "apple_empty" || scrubbed.reason === "short_quiet" ? scrubbed.reason : undefined,
  });
}

function audioStats(frames: ProsodyFrame[]) {
  const durationSec = frames.at(-1)?.t ?? 0;
  const peakRms = frames.reduce((max, frame) => Math.max(max, frame.rms), 0);
  return { durationSec, peakRms };
}
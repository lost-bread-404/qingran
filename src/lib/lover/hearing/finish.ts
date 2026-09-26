import type { ProsodyFrame, ToneThresholds } from "../prosody.ts";
import { finishHeard } from "../stt-text.ts";
import { heardFromHearing, type HeardUtterance } from "./heard.ts";
import { applyNightVoiceGate } from "./night-voice.ts";
import type { RunHearingOutput } from "./store.ts";
import { stripAcousticTags } from "./tags.ts";

/**
 * What happens after xAI has transcribed a clip: pick the text, recover 嗯 / 喘 / 笑
 * from the sound itself, add tone marks, then the voice-or-noise gate.
 * The browser call (hear.ts) and the iPhone shell's call (api/stt) both end here.
 */
export type FinishContext = {
  debugHearing: boolean;
  turnId: string;
  provider: string;
  /** Apple's on-device text. Empty in the iPhone shell's call. */
  liveText: string;
  frames: ProsodyFrame[];
  holdToTalk?: boolean;
  tone: ToneThresholds;
  endpointFired?: number;
  durationMs: number;
  voicedMin: number;
  minMs: number;
  pitchHoldMs: number;
  clarity: number;
};

export function audioStats(frames: ProsodyFrame[]) {
  const durationSec = frames.at(-1)?.t ?? 0;
  const peakRms = frames.reduce((max, frame) => Math.max(max, frame.rms), 0);
  return { durationSec, peakRms };
}

function engineFields(requested: string, result: RunHearingOutput) {
  return {
    engineRequested: result.engine_requested ?? requested,
    engineUsed: result.provider,
    engineFallback: result.engine_fallback_reason,
    engineErrorDetail: result.engine_error_detail,
    audioLlmMs: result.audio_llm_ms,
  };
}

export function finishHearing(result: RunHearingOutput, ctx: FinishContext): HeardUtterance {
  const seal = (heard: HeardUtterance, rawText: string) =>
    applyNightVoiceGate(heard, {
      voicedMin: ctx.voicedMin,
      minMs: ctx.minMs,
      pitchHoldMs: ctx.pitchHoldMs,
      clarity: ctx.clarity,
      stats: result.voice,
      frames: ctx.frames,
      durationMs: ctx.durationMs,
      rawText,
    });
  const engine = engineFields(ctx.provider, result);
  const base = {
    debugHearing: ctx.debugHearing,
    turnId: ctx.turnId,
    xaiText: result.xaiText,
    noiseOnly: result.noise_only,
    clipId: result.clipId,
    saveError: result.saveError,
    endpointFired: ctx.endpointFired,
    sttDoneAt: Date.now(),
    ...engine,
  };
  if (result.hallucinationSuspect) {
    return seal(
      heardFromHearing({
        ...base,
        tagged: "",
        hallucinationSuspect: true,
        hallucinationReason: result.hallucinationReason,
      }),
      result.xaiText ?? "",
    );
  }
  const finishOpts = { holdToTalk: ctx.holdToTalk, tone: ctx.tone };
  const stats = audioStats(ctx.frames);
  const xaiForFinish = result.correctedText ?? result.xaiText;
  const finished = () => finishHeard(xaiForFinish, ctx.liveText, result.words, ctx.frames, stats, finishOpts);
  const core =
    result.provider !== "xai" && result.tagged ? stripAcousticTags(result.tagged).trim() || finished() : finished();
  const tagged = stripAcousticTags(core).trim();
  return seal(heardFromHearing({ ...base, tagged }), result.correctedText || result.xaiText || tagged);
}

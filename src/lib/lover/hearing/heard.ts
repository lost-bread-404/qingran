import { shouldDropAsNoise } from "./noise.ts";
import type { AcousticTags } from "./tags.ts";

export const UNRECOGNIZED_TEXT = "〔未识别〕";

export type HeardUtterance = {
  text: string;
  turnId: string;
  clipId?: string;
  saveError?: string;
  skipQingran: boolean;
  /** Stored the clip and did not reply because it was not human voice. */
  nightNoise?: boolean;
  persistPending?: boolean;
  endpointFired?: number;
  sttDoneAt?: number;
  predictedTags?: AcousticTags;
  hallucinationSuspect?: boolean;
  hallucinationReason?: "apple_empty" | "short_quiet";
  engineRequested?: string;
  engineUsed?: string;
  engineFallback?: string;
  engineErrorDetail?: string;
  audioLlmMs?: number;
};

export function clipSaveBanner(error: string): string {
  return `录音没存上：${error}`;
}

export function errorText(err: unknown): string {
  if (err && typeof err === "object") {
    const row = err as { message?: string; code?: string; detail?: string };
    const parts = [row.message, row.code ? `code=${row.code}` : "", row.detail]
      .map((part) => (part ?? "").trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" · ");
  }
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? "unknown");
}

export function heardFromHearing(input: {
  debugHearing: boolean;
  turnId: string;
  tagged: string;
  xaiText: string;
  noiseOnly: boolean;
  clipId?: string;
  saveError?: string;
  endpointFired?: number;
  sttDoneAt?: number;
  predictedTags?: AcousticTags;
  hallucinationSuspect?: boolean;
  hallucinationReason?: "apple_empty" | "short_quiet";
  engineRequested?: string;
  engineUsed?: string;
  engineFallback?: string;
  engineErrorDetail?: string;
  audioLlmMs?: number;
}): HeardUtterance {
  const recognized = input.tagged.trim() || input.xaiText.trim();
  const empty =
    Boolean(input.hallucinationSuspect) || !recognized || shouldDropAsNoise(input.noiseOnly, input.xaiText);
  const timing = {
    endpointFired: input.endpointFired,
    sttDoneAt: input.sttDoneAt,
  };
  const extra = {
    hallucinationSuspect: input.hallucinationSuspect,
    hallucinationReason: input.hallucinationReason,
    engineRequested: input.engineRequested,
    engineUsed: input.engineUsed,
    engineFallback: input.engineFallback,
    engineErrorDetail: input.engineErrorDetail,
    audioLlmMs: input.audioLlmMs,
  };
  if (input.debugHearing) {
    return {
      text: empty ? UNRECOGNIZED_TEXT : recognized,
      turnId: input.turnId,
      clipId: input.clipId,
      saveError: input.saveError,
      skipQingran: empty,
      persistPending: true,
      predictedTags: input.predictedTags,
      ...timing,
      ...extra,
    };
  }
  return {
    text: empty ? "" : recognized,
    turnId: input.turnId,
    clipId: input.clipId,
    saveError: input.saveError,
    skipQingran: Boolean(input.hallucinationSuspect),
    predictedTags: input.predictedTags,
    ...timing,
    ...extra,
  };
}

export function voiceTurnIdForMessage(
  heard: Pick<HeardUtterance, "clipId" | "turnId" | "persistPending">,
): string | undefined {
  return heard.clipId || heard.persistPending ? heard.turnId : undefined;
}

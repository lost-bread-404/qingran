import { HEARING, type HearingProviderId } from "./config.ts";
import { formatTaggedText, type HearingResult } from "./schema.ts";

export type HearingFailReason = "timeout" | "refusal" | "schema" | "http" | "missing_key";

export type HearingAdapterOutcome =
  | { ok: true; result: HearingResult }
  | { ok: false; reason: HearingFailReason; raw?: string; latency_ms: number; provider: HearingProviderId; model: string };

export type XaiSide =
  | {
      ok: true;
      text: string;
      words: { text?: string; start?: number; end?: number }[];
      latency_ms: number;
      raw: string;
    }
  | { ok: false; error: string; latency_ms: number; quota?: boolean };

export type ChosenHearing = {
  used: HearingProviderId;
  hearing: HearingResult | null;
  fallback: boolean;
  fallback_reason?: HearingFailReason;
  tagged: string;
  xaiText: string;
  words: { text?: string; start?: number; end?: number }[];
  refusal: boolean;
};

export function chooseHearing(input: {
  provider: HearingProviderId;
  outcome: HearingAdapterOutcome | null;
  xai: XaiSide;
}): ChosenHearing {
  const xaiText = input.xai.ok ? input.xai.text : "";
  const words = input.xai.ok ? input.xai.words : [];
  const xaiHearing: HearingResult | null = input.xai.ok
    ? {
        text: xaiText,
        cues: [],
        utterance_emotion: "neutral",
        noise_only: !xaiText.trim(),
        raw: input.xai.raw,
        latency_ms: input.xai.latency_ms,
        provider: "xai",
        model: HEARING.xai.model,
        refusal: false,
      }
    : null;

  if (input.provider !== "xai" && input.outcome?.ok) {
    return {
      used: input.provider,
      hearing: input.outcome.result,
      fallback: false,
      tagged: formatTaggedText(input.outcome.result),
      xaiText,
      words,
      refusal: false,
    };
  }

  const failed = Boolean(input.provider !== "xai");
  return {
    used: "xai",
    hearing: xaiHearing,
    fallback: failed,
    fallback_reason: failed
      ? input.outcome && !input.outcome.ok
        ? input.outcome.reason
        : "http"
      : undefined,
    tagged: xaiText,
    xaiText,
    words,
    refusal: Boolean(input.outcome && !input.outcome.ok && input.outcome.reason === "refusal"),
  };
}

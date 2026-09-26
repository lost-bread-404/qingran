import { HEARING, type HearingProviderId } from "./config.ts";
import { formatTaggedText, type HearingResult } from "./schema.ts";

export type HearingFailReason = "timeout" | "refusal" | "schema" | "http" | "missing_key";

export type HearingAdapterOutcome =
  | { ok: true; result: HearingResult }
  | {
      ok: false;
      reason: HearingFailReason;
      raw?: string;
      status?: number;
      latency_ms: number;
      provider: HearingProviderId;
      model: string;
    };

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

export type EngineFallbackDisplay = "timeout" | "refused" | "error" | "missing_key";

export type EngineUseRow = { engine: string; n: number };
export type EngineFallbackRow = { reason: EngineFallbackDisplay; n: number };
export type EngineUseStats = {
  n: number;
  used: EngineUseRow[];
  fallback: EngineFallbackRow[];
};

const FALLBACK_ORDER: EngineFallbackDisplay[] = ["timeout", "refused", "error", "missing_key"];

export const ENGINE_ERROR_BODY_MAX = 500;
export const ENGINE_ERROR_DISPLAY_MAX = 100;

export function displayEngineFallback(reason?: string | null): EngineFallbackDisplay {
  if (reason === "timeout") return "timeout";
  if (reason === "refusal" || reason === "refused") return "refused";
  if (reason === "missing_key") return "missing_key";
  return "error";
}

export function redactEngineSecrets(raw: string): string {
  return raw
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&]key=)[^&\s"]+/gi, "$1[redacted]")
    .replace(/("?(?:api[_-]?key|access[_-]?token)"?\s*[:=]\s*")[^"]*/gi, "$1[redacted]");
}

export function formatEngineErrorDetail(status?: number | null, body?: string | null): string | null {
  const snippet = redactEngineSecrets(body ?? "").slice(0, ENGINE_ERROR_BODY_MAX);
  if (status == null && !snippet) return null;
  if (status == null) return snippet;
  return snippet ? `${status} ${snippet}` : String(status);
}

export function displayEngineErrorDetail(detail?: string | null): string {
  return (detail ?? "").trim().slice(0, ENGINE_ERROR_DISPLAY_MAX);
}

export function engineErrorDetailFromOutcome(
  outcome: HearingAdapterOutcome | null | undefined,
): string | null {
  if (!outcome || outcome.ok || outcome.reason !== "http") return null;
  return formatEngineErrorDetail(outcome.status, outcome.raw);
}

export function formatEngineLine(input: {
  requested?: string | null;
  used?: string | null;
  fallback?: boolean;
  fallbackReason?: string | null;
  errorDetail?: string | null;
}): string {
  const used = input.used || "xai";
  if (!input.fallback || !input.fallbackReason) return `引擎：${used}`;
  const line = `引擎：${used}(fallback: ${displayEngineFallback(input.fallbackReason)})`;
  const detail = input.fallbackReason === "http" ? displayEngineErrorDetail(input.errorDetail) : "";
  return detail ? `${line} ${detail}` : line;
}

export function emptyEngineUse(): EngineUseStats {
  return { n: 0, used: [], fallback: [] };
}

export function aggregateEngineUse(
  rows: Array<{ engine?: string | null; reason?: string | null; n?: number | null }>,
): EngineUseStats {
  const usedMap = new Map<string, number>();
  const fbMap = new Map<EngineFallbackDisplay, number>();
  let n = 0;
  for (const row of rows) {
    const count = Number(row.n) || 0;
    if (!count) continue;
    n += count;
    const engine = (row.engine || "xai").trim() || "xai";
    usedMap.set(engine, (usedMap.get(engine) ?? 0) + count);
    if (row.reason) {
      const reason = displayEngineFallback(row.reason);
      fbMap.set(reason, (fbMap.get(reason) ?? 0) + count);
    }
  }
  const used = [...usedMap.entries()]
    .map(([engine, count]) => ({ engine, n: count }))
    .sort((a, b) => b.n - a.n || a.engine.localeCompare(b.engine));
  const fallback = FALLBACK_ORDER.filter((reason) => fbMap.has(reason)).map((reason) => ({
    reason,
    n: fbMap.get(reason)!,
  }));
  return { n, used, fallback };
}

export function slowEngineHint(provider?: string | null): string {
  const id = (provider ?? "").trim();
  if (!id || id === "xai") return "";
  return `当前引擎：${id}（会拖慢识别）`;
}

export function engineLineFromHeard(heard: {
  engineRequested?: string;
  engineUsed?: string;
  engineFallback?: string;
  engineErrorDetail?: string;
}): string | undefined {
  if (!heard.engineUsed && !heard.engineRequested) return undefined;
  const line = formatEngineLine({
    requested: heard.engineRequested,
    used: heard.engineUsed,
    fallback: Boolean(heard.engineFallback),
    fallbackReason: heard.engineFallback,
    errorDetail: heard.engineErrorDetail,
  });
  const hint = slowEngineHint(heard.engineRequested);
  return hint ? `${hint} · ${line}` : line;
}

export function logHearingTurn(log: {
  requested: string;
  used: string;
  fallbackReason?: string | null;
  audioLlmMs?: number | null;
  errorDetail?: string | null;
}) {
  console.error(
    `[qingran-hear] engine_requested=${log.requested} engine_used=${log.used} fallback_reason=${log.fallbackReason ?? "-"} audio_llm_ms=${log.audioLlmMs ?? "-"} engine_error_detail=${log.errorDetail ?? "-"}`,
  );
}

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

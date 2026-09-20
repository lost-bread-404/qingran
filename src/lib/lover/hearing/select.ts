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

export type EngineFallbackDisplay = "timeout" | "refused" | "error" | "missing_key";

export type EngineUseRow = { engine: string; n: number };
export type EngineFallbackRow = { reason: EngineFallbackDisplay; n: number };
export type EngineUseStats = {
  n: number;
  used: EngineUseRow[];
  fallback: EngineFallbackRow[];
};

const FALLBACK_ORDER: EngineFallbackDisplay[] = ["timeout", "refused", "error", "missing_key"];

export function displayEngineFallback(reason?: string | null): EngineFallbackDisplay {
  if (reason === "timeout") return "timeout";
  if (reason === "refusal" || reason === "refused") return "refused";
  if (reason === "missing_key") return "missing_key";
  return "error";
}

export function formatEngineLine(input: {
  requested?: string | null;
  used?: string | null;
  fallback?: boolean;
  fallbackReason?: string | null;
}): string {
  const used = input.used || "xai";
  if (!input.fallback || !input.fallbackReason) return `引擎：${used}`;
  return `引擎：${used}(fallback: ${displayEngineFallback(input.fallbackReason)})`;
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

export function formatEngineMix(stats: EngineUseStats | null | undefined): string {
  if (!stats?.n) return "无数据";
  const mix = stats.used
    .map((row) => `${row.engine} ${Math.round((row.n / stats.n) * 100)}%`)
    .join(" · ");
  if (!stats.fallback.length) return mix;
  const fb = stats.fallback.map((row) => `${row.reason} ${row.n}`).join(" · ");
  return `${mix} · 退回 ${fb}`;
}

export function engineLineFromHeard(heard: {
  engineRequested?: string;
  engineUsed?: string;
  engineFallback?: string;
}): string | undefined {
  if (!heard.engineUsed && !heard.engineRequested) return undefined;
  return formatEngineLine({
    requested: heard.engineRequested,
    used: heard.engineUsed,
    fallback: Boolean(heard.engineFallback),
    fallbackReason: heard.engineFallback,
  });
}

export function logHearingTurn(log: {
  requested: string;
  used: string;
  fallbackReason?: string | null;
  audioLlmMs?: number | null;
}) {
  console.error(
    `[qingran-hear] engine_requested=${log.requested} engine_used=${log.used} fallback_reason=${log.fallbackReason ?? "-"} audio_llm_ms=${log.audioLlmMs ?? "-"}`,
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

import { MODEL_PRICES } from "./config.ts";
import { llmCostFromText, llmCostUsd } from "./spend/cost.ts";

export const TICKS_PER_USD = 10_000_000_000;

export type TokenUsage = {
  tokensIn: number | null;
  tokensCached: number | null;
  tokensOut: number | null;
  tokensReasoning: number | null;
  costTicks?: number | null;
};

export type CostSource = "xai" | "price_table" | "char_estimate";

export function ticksToUsd(ticks: number): number {
  return ticks / TICKS_PER_USD;
}

export function parseUsage(raw: unknown): TokenUsage {
  const empty: TokenUsage = {
    tokensIn: null,
    tokensCached: null,
    tokensOut: null,
    tokensReasoning: null,
    costTicks: null,
  };
  if (!raw || typeof raw !== "object") return empty;
  const u = raw as Record<string, unknown>;
  const detailsIn =
    u.input_tokens_details && typeof u.input_tokens_details === "object"
      ? (u.input_tokens_details as Record<string, unknown>)
      : u.prompt_tokens_details && typeof u.prompt_tokens_details === "object"
        ? (u.prompt_tokens_details as Record<string, unknown>)
        : {};
  const detailsOut =
    u.output_tokens_details && typeof u.output_tokens_details === "object"
      ? (u.output_tokens_details as Record<string, unknown>)
      : u.completion_tokens_details && typeof u.completion_tokens_details === "object"
        ? (u.completion_tokens_details as Record<string, unknown>)
        : {};
  const num = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const cachedObj =
    typeof u.prompt_tokens_details === "object" && u.prompt_tokens_details
      ? (u.prompt_tokens_details as Record<string, unknown>)
      : detailsIn;
  return {
    tokensIn: num(u.input_tokens ?? u.prompt_tokens),
    tokensCached: num(detailsIn.cached_tokens ?? cachedObj.cached_tokens ?? u.cached_tokens),
    tokensOut: num(u.output_tokens ?? u.completion_tokens),
    tokensReasoning: num(detailsOut.reasoning_tokens ?? u.reasoning_tokens),
    costTicks: num(u.cost_in_usd_ticks),
  };
}

export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  if (!MODEL_PRICES[model]) return null;
  return llmCostUsd(model, usage)?.usd ?? null;
}

export function settleLlmCost(
  model: string,
  usage: TokenUsage,
  inputText: string,
  outputText: string,
): {
  usd: number;
  usdEst: number | null;
  source: CostSource;
  estimated: boolean;
  tokensIn?: number;
  tokensOut?: number;
} {
  const priced = llmCostUsd(model, usage);
  const ticks = usage.costTicks;
  if (ticks != null && ticks >= 0) {
    return {
      usd: ticksToUsd(ticks),
      usdEst: priced?.usd ?? null,
      source: "xai",
      estimated: false,
    };
  }
  if (priced) {
    return { usd: priced.usd, usdEst: priced.usd, source: "price_table", estimated: false };
  }
  const est = llmCostFromText(model, inputText, outputText);
  return {
    usd: est.usd,
    usdEst: est.usd,
    source: "char_estimate",
    estimated: true,
    tokensIn: est.tokensIn,
    tokensOut: est.tokensOut,
  };
}

export function formatMindAge(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(0, Math.floor(ms / 60_000))} 分钟`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时`;
  return `${Math.floor(ms / 86_400_000)} 天`;
}

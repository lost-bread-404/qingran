import { MODEL_PRICES } from "./config.ts";
import { llmCostUsd } from "./spend/cost.ts";

export type TokenUsage = {
  tokensIn: number | null;
  tokensCached: number | null;
  tokensOut: number | null;
  tokensReasoning: number | null;
};

export function parseUsage(raw: unknown): TokenUsage {
  const empty: TokenUsage = {
    tokensIn: null,
    tokensCached: null,
    tokensOut: null,
    tokensReasoning: null,
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
  const cachedObj = typeof u.prompt_tokens_details === "object" && u.prompt_tokens_details
    ? (u.prompt_tokens_details as Record<string, unknown>)
    : detailsIn;
  return {
    tokensIn: num(u.input_tokens ?? u.prompt_tokens),
    tokensCached: num(detailsIn.cached_tokens ?? cachedObj.cached_tokens ?? u.cached_tokens),
    tokensOut: num(u.output_tokens ?? u.completion_tokens),
    tokensReasoning: num(detailsOut.reasoning_tokens ?? u.reasoning_tokens),
  };
}

export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  if (!MODEL_PRICES[model]) return null;
  return llmCostUsd(model, usage)?.usd ?? null;
}

export function formatMindAge(ms: number): string {
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  if (hours < 48) return `${hours} 小时`;
  const days = Math.max(1, Math.round(ms / 86_400_000));
  return `${days} 天`;
}
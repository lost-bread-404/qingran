import { MODEL_PRICES, VOICE_PRICES } from "../config.ts";
import type { TokenUsage } from "../usage.ts";

export const LONG_CONTEXT_TOKENS = 200_000;

export function estimateTokensFromChars(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch >= "\u3400" && ch <= "\u9fff") cjk += 1;
    else if (ch.trim()) other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function pricesFor(model: string, tokensIn: number): { input: number; cached: number; output: number } | null {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  if (tokensIn >= LONG_CONTEXT_TOKENS) {
    return { input: p.input * 2, cached: p.cached * 2, output: p.output * 2 };
  }
  return p;
}

/** reasoning_tokens 不包含在 completion/output 里，按输出价另计。 */
export function llmCostUsd(model: string, usage: TokenUsage): { usd: number; estimated: boolean } | null {
  if (usage.tokensIn == null && usage.tokensOut == null && usage.tokensReasoning == null) return null;
  const input = usage.tokensIn ?? 0;
  const cached = Math.min(usage.tokensCached ?? 0, input);
  const output = usage.tokensOut ?? 0;
  const reasoning = usage.tokensReasoning ?? 0;
  const p = pricesFor(model, input);
  if (!p) return null;
  const uncached = Math.max(0, input - cached);
  const usd = (uncached * p.input + cached * p.cached + (output + reasoning) * p.output) / 1_000_000;
  return { usd, estimated: false };
}

export function llmCostFromText(model: string, inputText: string, outputText: string): {
  usd: number;
  estimated: boolean;
  tokensIn: number;
  tokensOut: number;
} {
  const tokensIn = estimateTokensFromChars(inputText);
  const tokensOut = estimateTokensFromChars(outputText);
  const p = pricesFor(model, tokensIn) ?? { input: 1.25, cached: 0.2, output: 2.5 };
  const usd = (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
  return { usd, estimated: true, tokensIn, tokensOut };
}

export function ttsCostUsd(chars: number): number {
  return (Math.max(0, chars) * VOICE_PRICES.ttsPerMillionChars) / 1_000_000;
}

export function sttCostUsd(seconds: number, streaming: boolean): number {
  const perHour = streaming ? VOICE_PRICES.sttStreamingPerHour : VOICE_PRICES.sttRestPerHour;
  return (Math.max(0, seconds) / 3600) * perHour;
}

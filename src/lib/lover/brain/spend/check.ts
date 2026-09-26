import { recordSpend } from "./ledger.ts";
import { sttCostUsd, ttsCostUsd } from "./cost.ts";
import { settleLlmCost, type TokenUsage } from "../usage.ts";

export async function recordLlmSpend(opts: {
  route: string;
  model: string;
  usage: TokenUsage;
  inputText: string;
  outputText: string;
  turnSeq?: number | null;
  jobId?: string | null;
  logId?: number | null;
  /** Paid by her SuperGrok subscription: recorded, but costs nothing on the API bill. */
  paidBy?: "sub" | "api";
}): Promise<void> {
  const settled = settleLlmCost(opts.model, opts.usage, opts.inputText, opts.outputText);
  const sub = opts.paidBy === "sub";
  await recordSpend({
    kind: "llm",
    route: opts.route,
    model: opts.model,
    tokensIn: opts.usage.tokensIn ?? settled.tokensIn ?? null,
    tokensCached: opts.usage.tokensCached,
    tokensOut: opts.usage.tokensOut ?? settled.tokensOut ?? null,
    tokensReasoning: opts.usage.tokensReasoning,
    usd: sub ? 0 : settled.usd,
    usdEst: settled.usdEst,
    costSource: sub ? "supergrok" : settled.source,
    estimated: settled.estimated,
    turnSeq: opts.turnSeq,
    jobId: opts.jobId,
    logId: opts.logId,
  });
}

export async function recordTtsSpend(chars: number, turnSeq?: number | null, paidBy: "sub" | "api" = "api"): Promise<void> {
  if (chars <= 0) return;
  const sub = paidBy === "sub";
  await recordSpend({ kind: "tts", route: "tts", chars, usd: sub ? 0 : ttsCostUsd(chars), costSource: sub ? "supergrok" : "price_table", usdEst: ttsCostUsd(chars), turnSeq });
}

export async function recordSttSpend(seconds: number, streaming = false, turnSeq?: number | null, paidBy: "sub" | "api" = "api"): Promise<void> {
  if (seconds <= 0) return;
  const sub = paidBy === "sub";
  await recordSpend({
    kind: "stt",
    route: "stt",
    seconds,
    usd: sub ? 0 : sttCostUsd(seconds, streaming),
    costSource: sub ? "supergrok" : "price_table",
    usdEst: sttCostUsd(seconds, streaming),
    turnSeq,
  });
}


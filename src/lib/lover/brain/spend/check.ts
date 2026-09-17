import { now } from "../clock.ts";
import { getMeta } from "../store.ts";
import { localDay } from "../time.ts";
import { listOverrides, loadTotals, recordSpend, resolvedLimits, writeAlert } from "./ledger.ts";
import { spendDecision, type SpendDecision } from "./policy.ts";
import { llmCostFromText, llmCostUsd, sttCostUsd, ttsCostUsd } from "./cost.ts";
import type { TokenUsage } from "../usage.ts";

export async function checkSpend(route: string): Promise<SpendDecision> {
  const [totals, limits, meta] = await Promise.all([loadTotals(), resolvedLimits(), getMeta()]);
  const tz = meta.timeZone || "UTC";
  const overrides = await listOverrides(totals.day, totals.month);
  const decision = spendDecision(route, totals.dayUsd, totals.monthUsd, limits, overrides, now(), tz);
  if (decision.level !== "ok" && decision.scope) {
    await writeAlert(
      decision.scope,
      decision.level,
      decision.scope === "day" ? totals.dayUsd : totals.monthUsd,
      `${route} ${decision.level} ${decision.scope}=${(decision.scope === "day" ? totals.dayUsd : totals.monthUsd).toFixed(4)}`,
    );
  }
  return decision;
}

export async function recordLlmSpend(opts: {
  route: string;
  model: string;
  usage: TokenUsage;
  inputText: string;
  outputText: string;
  turnSeq?: number | null;
  jobId?: string | null;
  logId?: number | null;
}): Promise<void> {
  const priced = llmCostUsd(opts.model, opts.usage);
  if (priced) {
    await recordSpend({
      kind: "llm",
      route: opts.route,
      model: opts.model,
      tokensIn: opts.usage.tokensIn,
      tokensCached: opts.usage.tokensCached,
      tokensOut: opts.usage.tokensOut,
      tokensReasoning: opts.usage.tokensReasoning,
      usd: priced.usd,
      estimated: false,
      turnSeq: opts.turnSeq,
      jobId: opts.jobId,
      logId: opts.logId,
    });
    return;
  }
  const est = llmCostFromText(opts.model, opts.inputText, opts.outputText);
  await recordSpend({
    kind: "llm",
    route: opts.route,
    model: opts.model,
    tokensIn: est.tokensIn,
    tokensOut: est.tokensOut,
    usd: est.usd,
    estimated: true,
    turnSeq: opts.turnSeq,
    jobId: opts.jobId,
    logId: opts.logId,
  });
}

export async function recordTtsSpend(chars: number, turnSeq?: number | null): Promise<void> {
  if (chars <= 0) return;
  await recordSpend({ kind: "tts", route: "tts", chars, usd: ttsCostUsd(chars), turnSeq });
}

export async function recordSttSpend(seconds: number, streaming = false, turnSeq?: number | null): Promise<void> {
  if (seconds <= 0) return;
  await recordSpend({
    kind: "stt",
    route: "stt",
    seconds,
    usd: sttCostUsd(seconds, streaming),
    turnSeq,
  });
}

export function spendPeriod(nowMs = now(), tz = "UTC") {
  const day = localDay(nowMs, tz);
  return { day, month: day.slice(0, 7) };
}

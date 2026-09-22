import { appendBrainLog } from "./store.ts";
import { insertBrainTurn } from "./observability.ts";
import { recordLlmSpend, recordTtsSpend } from "./spend/check.ts";
import { parseUsage, settleLlmCost, type TokenUsage } from "./usage.ts";
import { codeVersion, maybeWriteRawLog } from "./log-refs.ts";
import type { HotContext } from "./voice/pack.ts";
import { firstLine } from "../talk-fail.ts";

export async function recordVoiceTurn(opts: {
  ctx: HotContext;
  replyId: string;
  display: string;
  failed: boolean;
  model: string | null;
  usage: TokenUsage | unknown;
  totalMs: number;
  ttftMs: number | null;
  firstAudioMs: number | null;
  userCreatedAt: number;
  userMsgId: string;
  localDay: string;
  ttsChars?: number;
  finishReason?: string | null;
  note?: string | null;
  effort?: string | null;
}): Promise<number | null> {
  const usage: TokenUsage =
    opts.usage && typeof opts.usage === "object" && "tokensIn" in (opts.usage as object)
      ? (opts.usage as TokenUsage)
      : parseUsage(opts.usage);
  const model = opts.model || "voice";
  const inputText = opts.ctx.messages.map((m) => m.content).join("\n");
  const settled = settleLlmCost(model, usage, inputText, opts.display);
  const outputRef = opts.display ? `message:${opts.replyId}` : null;
  const note =
    opts.note ??
    (opts.finishReason ? `finish_reason=${opts.finishReason}` : null);
  const logId = await appendBrainLog({
    step: `voice:${model}`,
    ok: !opts.failed && Boolean(opts.display),
    ms: opts.totalMs,
    inputChars: inputText.length,
    raw: (opts.display || note || "").slice(0, 4000),
    note,
    route: "voice",
    model: opts.model,
    effort: opts.effort ?? null,
    turnSeq: opts.userCreatedAt,
    inputSystem: null,
    inputUser: null,
    outputText: null,
    tokensIn: usage.tokensIn ?? settled.tokensIn ?? null,
    tokensCached: usage.tokensCached,
    tokensOut: usage.tokensOut ?? settled.tokensOut ?? null,
    tokensReasoning: usage.tokensReasoning,
    costUsd: settled.usd,
    costUsdEst: settled.usdEst,
    error: opts.failed ? firstLine(note) || "stream-error" : null,
    codeVersion: codeVersion(),
    refs: opts.ctx.refs,
    outputRef,
  });
  await maybeWriteRawLog(logId, { messages: opts.ctx.messages });
  await recordLlmSpend({
    route: "voice",
    model,
    usage,
    inputText,
    outputText: opts.display,
    turnSeq: opts.userCreatedAt,
    logId,
  });
  if (opts.ttsChars) await recordTtsSpend(opts.ttsChars, opts.userCreatedAt);
  await insertBrainTurn({
    turnSeq: opts.userCreatedAt,
    userMsgId: opts.userMsgId,
    replyMsgId: opts.display ? opts.replyId : null,
    localDay: opts.localDay,
    sessionId: opts.ctx.sessionId,
    mindTurnSeq: opts.ctx.mindTurnSeq,
    mindAgeMs: opts.ctx.mindAgeMs,
    mindStale: opts.ctx.mindStale,
    pickedIds: opts.ctx.pickedIds,
    fallbackIds: opts.ctx.fallbackIds,
    queryIds: opts.ctx.queryIds,
    queryScores: opts.ctx.queryScores,
    jump: opts.ctx.jump,
    jumpScore: opts.ctx.jumpScore,
    careHint: opts.ctx.careHint,
    replyChars: opts.display.length,
    packMs: opts.ctx.packMs,
    dbFirstMs: opts.ctx.dbFirstMs,
    ttftMs: opts.ttftMs,
    firstAudioMs: opts.firstAudioMs,
    totalMs: opts.totalMs,
    voiceModel: opts.model,
    codeVersion: codeVersion(),
    charterHash: opts.ctx.charterHash,
    longtermHash: opts.ctx.longtermHash,
    historyIds: opts.ctx.historyIds,
    clockText: opts.ctx.clockText,
  });
  return logId;
}

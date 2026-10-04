import { appendBrainLog } from "./store.ts";
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
  /** Who paid for this turn (SuperGrok subscription or API key). */
  paidBy?: "sub" | "api";
  finishReason?: string | null;
  note?: string | null;
  effort?: string | null;
  personaMissing?: boolean;
  /** What was really sent (Claude and Grok are given different messages); default: the pack's. */
  messages?: Array<{ role: string; content: string }>;
  /** Who played her this turn (docs/claude-grok-routing.md「记录」). */
  route?: { engine: string; mark: string | null; modeBefore: string; modeAfter?: string; autoReturn: boolean };
}): Promise<number | null> {
  const usage: TokenUsage =
    opts.usage && typeof opts.usage === "object" && "tokensIn" in (opts.usage as object)
      ? (opts.usage as TokenUsage)
      : parseUsage(opts.usage);
  const model = opts.model || "voice";
  const messages = opts.messages ?? opts.ctx.messages;
  // What he was given to remember this turn, readable in 记录 (she asked to see it, 10/4).
  const claudeTurn = opts.route?.engine === "claude";
  const memoryLines = (opts.ctx.recalled ?? []).map((m) => `· ${m.body.trim()}`);
  const innerText = (claudeTurn ? opts.ctx.parts.innerDaily : opts.ctx.parts.inner).trim();
  const sentMemory = [
    `══ 带上的往事（${memoryLines.length} 件${opts.ctx.recallBy === "all" ? "，全部" : opts.ctx.recallBy === "none" ? "" : "，按这句找的"}）══`,
    memoryLines.join("\n") || "（没有）",
    "══ 他之前心里想的（这一段对话里的）══",
    innerText || "（没有）",
  ].join("\n");
  const inputText = messages.map((m) => m.content).join("\n");
  const settled = settleLlmCost(model, usage, inputText, opts.display);
  const outputRef = opts.display ? `message:${opts.replyId}` : null;
  const note = [opts.note ?? (opts.finishReason ? `finish_reason=${opts.finishReason}` : null), sentMemory]
    .filter(Boolean)
    .join("\n\n");
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const rest = messages.filter((m, i) => !(i === messages.findIndex((row) => row.role === "system") && m.role === "system"));
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
    inputSystem: system || null,
    inputUser: rest.length ? rest.map((m) => `【${m.role}】\n${m.content}`).join("\n\n") : null,
    outputText: opts.display || null,
    tokensIn: usage.tokensIn ?? settled.tokensIn ?? null,
    tokensCached: usage.tokensCached,
    tokensOut: usage.tokensOut ?? settled.tokensOut ?? null,
    tokensReasoning: usage.tokensReasoning,
    costUsd: settled.usd,
    costUsdEst: settled.usdEst,
    error: opts.failed ? firstLine(note) || "stream-error" : null,
    codeVersion: codeVersion(),
    // One record per turn: what he was given (refs) and how the turn went.
    refs: {
      ...opts.ctx.refs,
      localDay: opts.localDay,
      packMs: opts.ctx.packMs,
      dbFirstMs: opts.ctx.dbFirstMs,
      ttftMs: opts.ttftMs,
      firstAudioMs: opts.firstAudioMs,
      ...(opts.personaMissing ? { personaMissing: true } : {}),
      ...(opts.route ? { ...opts.route, mark: opts.route.mark ? `〔${opts.route.mark}〕` : "无" } : {}),
    },
    outputRef,
    promptKey: opts.ctx.promptKey,
    promptHash: opts.ctx.promptHash,
  });
  await maybeWriteRawLog(logId, { messages });
  await recordLlmSpend({
    route: "voice",
    model,
    usage,
    inputText,
    outputText: opts.display,
    turnSeq: opts.userCreatedAt,
    logId,
    paidBy: opts.paidBy,
  });
  if (opts.ttsChars) await recordTtsSpend(opts.ttsChars, opts.userCreatedAt, opts.paidBy);
  return logId;
}

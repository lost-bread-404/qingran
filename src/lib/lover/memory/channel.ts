import { formatClock } from "../prompt";
import type { ChatMessage } from "../types";
import { buildMainMessages, clipPortrait, countChars } from "./pack";
import {
  PROMPT_A_SYSTEM,
  PROMPT_B_SYSTEM,
  PROMPT_C_SYSTEM,
  buildPromptAUser,
  buildPromptBUser,
  buildPromptCUser,
  formatDropped,
  parseDecisionA,
  parseL2List,
  parseMaybeTime,
  parsePatternsAndPortrait,
} from "./prompts";
import { buildQuery, retrieveCandidates } from "./retrieve";
import {
  appendLog,
  insertL1,
  insertL2,
  loadAllMessages,
  loadL1Since,
  loadL2,
  loadL3,
  loadMeta,
  loadOpenEvent,
  loadPortrait,
  loadRetrievable,
  markScanned,
  replaceL3,
  saveMeta,
  saveOpenEvent,
  savePortrait,
} from "./store";
import {
  CONTEXT_WINDOW,
  DROPPED_PACK_LIMIT,
  MAX_MAIN_MEMORIES,
  MAX_PORTRAIT_CHARS,
  type MainPackInput,
  type PackedChatMessage,
  type PackedMemory,
} from "./types";

const FAST_MODEL = "grok-4.20-0309-non-reasoning";

type ChatJsonResult = { ok: true; text: string } | { ok: false; error: string };

let tickLock: Promise<void> | null = null;

export async function assembleMainPack(opts: {
  charter: string;
  history: ChatMessage[];
  userText: string;
  nowMs: number;
  timeZone: string;
}): Promise<{ messages: PackedChatMessage[]; stats: Record<string, number> }> {
  const clock = (ms: number) => formatClock(ms, opts.timeZone);
  const [portrait, items] = await Promise.all([loadPortrait(), loadRetrievable()]);
  const query = buildQuery(
    opts.userText,
    opts.history.filter((m) => m.role === "user").slice(-2).map((m) => m.text),
  );
  const candidates = retrieveCandidates({
    query,
    items,
    now: opts.nowMs,
  });
  const memories: PackedMemory[] = candidates.slice(0, MAX_MAIN_MEMORIES).map((item) => ({
    time: clock(item.startedAt),
    text: item.text,
    dormant: item.layer === "l3" && item.status === "dormant",
  }));
  const history = opts.history.slice(-(CONTEXT_WINDOW - 1)).map((m) => ({
    role: m.role,
    content: m.text,
  }));
  const pack: MainPackInput = {
    charter: opts.charter,
    clock: clock(opts.nowMs),
    portrait,
    memories,
    history,
    userText: opts.userText.trim(),
  };
  const messages = buildMainMessages(pack);
  const stats = {
    charter: pack.charter.length,
    portrait: portrait.length,
    memories: memories.length,
    history: history.length,
    status: messages[1]?.content.length ?? 0,
  };
  await appendLog("pack", `memories=${memories.length}`, stats);
  return { messages, stats };
}

export function tickMemory(timeZone = "UTC"): Promise<void> {
  if (tickLock) return tickLock;
  tickLock = runTick(timeZone).finally(() => {
    tickLock = null;
  });
  return tickLock;
}

async function runTick(timeZone: string): Promise<void> {
  try {
    await saveMeta({ timeZone });
    await processDropped(timeZone);
    await maybeInterval(timeZone);
  } catch (error) {
    await appendLog("tick_error", String(error).slice(0, 80));
  }
}

async function processDropped(timeZone: string): Promise<void> {
  const clock = (ms: number) => formatClock(ms, timeZone);
  const messages = await loadAllMessages();
  const overflowAt = Math.max(0, messages.length - CONTEXT_WINDOW);
  if (overflowAt === 0) return;
  const dropped = messages.slice(0, overflowAt).filter((m) => !m.scanned).slice(0, DROPPED_PACK_LIMIT);
  if (dropped.length === 0) return;

  const open = await loadOpenEvent();
  const result = await chatJson({
    system: PROMPT_A_SYSTEM,
    user: buildPromptAUser({ open, dropped, clock }),
    maxTokens: 800,
    timeoutMs: 20_000,
    temperature: 0.2,
  });
  if (!result.ok) {
    await appendLog("a_fail", result.error);
    return;
  }
  const decision = parseDecisionA(result.text);
  if (!decision) {
    await appendLog("a_parse_fail", result.text.slice(0, 80));
    return;
  }

  const ids = dropped.map((m) => m.id);
  if (decision.decision === "ignore") {
    await markScanned(ids);
    await appendLog("ignore", decision.note, { n: ids.length });
    return;
  }

  if (decision.decision === "merge") {
    const startedAt = parseMaybeTime(decision.openStart, open?.startedAt || dropped[0]!.createdAt);
    const points = appendPoints(open?.points ?? "", dropped, clock);
    await saveOpenEvent({
      startedAt,
      draft: (decision.openDraft || open?.draft || "").slice(0, 800),
      points,
    });
    await markScanned(ids);
    await appendLog("merge", decision.note, { n: ids.length });
    return;
  }

  const closedText = decision.closedEvent.trim() || open?.draft.trim() || "";
  if (closedText && (open || closedText)) {
    const startedAt = parseMaybeTime(decision.closedStart, open?.startedAt || dropped[0]!.createdAt);
    const endedAt = parseMaybeTime(decision.closedEnd, dropped.at(-1)?.createdAt || Date.now());
    await insertL1({
      startedAt,
      endedAt: Math.max(endedAt, startedAt),
      text: closedText,
    });
  }
  const openDraft = decision.openDraft.trim();
  await saveOpenEvent(
    openDraft
      ? {
          startedAt: parseMaybeTime(decision.openStart, dropped[0]!.createdAt),
          draft: openDraft.slice(0, 800),
          points: appendPoints("", dropped, clock),
        }
      : null,
  );
  await markScanned(ids);
  await appendLog("close_and_open", decision.note, { n: ids.length, closed: Boolean(closedText) });
}

async function maybeInterval(timeZone: string): Promise<void> {
  const now = Date.now();
  const today = dayKey(now, timeZone);
  const meta = await loadMeta();
  if (meta.intervalRetryAt > now) return;
  if (meta.lastIntervalDay === today) return;

  const since = meta.lastIntervalAt || 0;
  const l1 = (await loadL1Since(since)).slice(0, 40);
  const hasWork = l1.length > 0 || (await loadL3()).length > 0 || (await loadPortrait()).length > 0;
  if (!hasWork && !meta.lastIntervalDay) {
    await saveMeta({ lastIntervalAt: now, lastIntervalDay: today, intervalRetryAt: 0, timeZone });
    return;
  }

  const clock = (ms: number) => formatClock(ms, timeZone);
  const periodStart = since ? clock(since) : today;
  const periodEnd = clock(now);

  try {
    const newL2 = await collapseL2({ periodStart, periodEnd, l1, clock });
    await rewriteState({
      periodStart,
      periodEnd,
      newL2,
      clock,
      now,
    });
    await saveMeta({ lastIntervalAt: now, lastIntervalDay: today, intervalRetryAt: 0, timeZone });
    await appendLog("interval", today, { l1: l1.length, l2: newL2.length });
  } catch (error) {
    await saveMeta({ intervalRetryAt: now + 30 * 60_000, timeZone });
    await appendLog("interval_fail", String(error).slice(0, 80));
  }
}

async function collapseL2(opts: {
  periodStart: string;
  periodEnd: string;
  l1: Array<{ startedAt: number; endedAt: number; text: string }>;
  clock: (ms: number) => string;
}): Promise<Array<{ time: string; text: string }>> {
  if (opts.l1.length === 0) return [];
  const result = await chatJson({
    system: PROMPT_B_SYSTEM,
    user: buildPromptBUser(opts),
    maxTokens: 1200,
    timeoutMs: 24_000,
    temperature: 0.3,
  });
  if (!result.ok) throw new Error(result.error);
  const list = parseL2List(result.text);
  if (!list) throw new Error("l2-parse");
  const now = Date.now();
  const written = [];
  for (const item of list) {
    const row = await insertL2({
      periodStart: parseMaybeTime(opts.periodStart, now - 86_400_000),
      periodEnd: parseMaybeTime(opts.periodEnd, now),
      text: item.text,
    });
    written.push({ time: item.time, text: row.text });
  }
  return written;
}

async function rewriteState(opts: {
  periodStart: string;
  periodEnd: string;
  newL2: Array<{ time: string; text: string }>;
  clock: (ms: number) => string;
  now: number;
}): Promise<void> {
  const [oldL2, oldL3, portrait, open] = await Promise.all([
    loadL2(),
    loadL3(),
    loadPortrait(),
    loadOpenEvent(),
  ]);
  if (opts.newL2.length === 0 && oldL2.length === 0 && oldL3.length === 0 && !portrait) return;
  const result = await chatJson({
    system: PROMPT_C_SYSTEM,
    user: buildPromptCUser({
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      newL2: opts.newL2,
      oldL2: oldL2.slice(0, 24),
      oldL3,
      portrait,
      openDraft: open?.draft ?? "",
      now: opts.now,
      clock: opts.clock,
    }),
    maxTokens: 2000,
    timeoutMs: 30_000,
    temperature: 0.4,
  });
  if (!result.ok) throw new Error(result.error);
  const parsed = parsePatternsAndPortrait(result.text);
  if (!parsed) {
    await appendLog("c_parse_fail", result.text.slice(0, 80));
    return;
  }
  if (parsed.portrait.trim()) {
    const portrait = clipPortrait(parsed.portrait, MAX_PORTRAIT_CHARS);
    if (countChars(parsed.portrait) > MAX_PORTRAIT_CHARS) {
      await appendLog("portrait_clipped", String(countChars(parsed.portrait)));
    }
    if (portrait) await savePortrait(portrait);
  }
  if (parsed.patterns.length) {
    await replaceL3(parsed.patterns, opts.now);
  }
}

function appendPoints(prev: string, dropped: ChatMessage[], clock: (ms: number) => string): string {
  const extra = formatDropped(dropped, clock);
  return `${prev}\n${extra}`.trim().slice(-2000);
}

function dayKey(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

async function chatJson(opts: {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  temperature: number;
}): Promise<ChatJsonResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no-key" };
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: FAST_MODEL,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `xai-${res.status}` };
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) return { ok: false, error: "empty" };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 80) };
  }
}

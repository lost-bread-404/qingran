import { formatClock } from "../prompt";
import type { ChatMessage } from "../types";
import { planArchive } from "./apply";
import { writeJournal } from "./journal";
import { buildMainMessages, clipPortrait, countChars, selectPackMemories } from "./pack";
import {
  PROMPT_A_SYSTEM,
  PROMPT_B_SYSTEM,
  PROMPT_C_SYSTEM,
  PROMPT_D_SYSTEM,
  buildPromptAUser,
  buildPromptBUser,
  buildPromptCUser,
  buildPromptDUser,
  parseArchiveA,
  parseL2List,
  parseMaybeTime,
  parsePatternsAndPortrait,
  parsePickedIds,
} from "./prompts";
import {
  appendLog,
  insertL1,
  loadAllMessages,
  loadL1Since,
  loadL2,
  loadL3,
  loadMeta,
  loadOpenThreads,
  loadPortrait,
  loadRetrievable,
  markScanned,
  replaceL3,
  replaceOpenThreads,
  saveMeta,
  savePortrait,
  upsertL2,
} from "./store";
import {
  CONTEXT_WINDOW,
  DROPPED_PACK_LIMIT,
  MAX_PORTRAIT_CHARS,
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
  const [portrait, opens, items, meta] = await Promise.all([
    loadPortrait(),
    loadOpenThreads(),
    loadRetrievable(),
    loadMeta(),
  ]);
  const pickedItems = items.filter((item) => meta.pickedIds.includes(item.id));
  const picked: PackedMemory[] = pickedItems.map((item) => ({
    time: clock(item.startedAt),
    text: item.text,
    dormant: item.layer === "l3" && item.status === "dormant",
    open: item.layer === "open",
  }));
  const openMem: PackedMemory[] = opens.map((item) => ({
    time: clock(item.startedAt),
    text: item.text,
    open: true,
  }));
  const memories = selectPackMemories(picked, openMem);
  const history = opts.history.slice(-(CONTEXT_WINDOW - 1)).map((m) => ({
    role: m.role,
    content: m.text,
  }));
  const messages = buildMainMessages({
    charter: opts.charter,
    clock: clock(opts.nowMs),
    portrait,
    memories,
    history,
    userText: opts.userText.trim(),
  });
  const stats = {
    charter: opts.charter.length,
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
    await pickRelated(timeZone);
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

  const open = await loadOpenThreads();
  const result = await chatJson({
    system: PROMPT_A_SYSTEM,
    user: buildPromptAUser({ open, dropped, clock }),
    maxTokens: 800,
    timeoutMs: 20_000,
    temperature: 0.2,
  });
  if (!result.ok) {
    await appendLog("a_fail", result.error);
    await writeJournal("process", { step: "A", decision: "fail", note: result.error });
    return;
  }
  const archive = parseArchiveA(result.text);
  if (!archive) {
    await appendLog("a_parse_fail", result.text.slice(0, 80));
    await writeJournal("process", { step: "A", decision: "parse_fail", raw: result.text.slice(0, 4000) });
    return;
  }

  const plan = planArchive({ archive, dropped });
  for (const row of plan.facts) {
    await insertL1({
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      text: row.text,
    });
  }
  await replaceOpenThreads(plan.open);
  await markScanned(plan.scannedIds);
  await appendLog("archive", `${plan.facts.length} facts / ${plan.open.length} open`, {
    n: plan.scannedIds.length,
  });
  await writeJournal("process", {
    step: "A",
    decision: "archive",
    facts: plan.facts.map((item) => item.text).join(" / "),
    draft: plan.open.map((item) => item.text).join(" / "),
    raw: result.text.slice(0, 4000),
  });
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
}): Promise<Array<{ id: string; time: string; text: string }>> {
  if (opts.l1.length === 0) return [];
  const oldL2 = await loadL2();
  const result = await chatJson({
    system: PROMPT_B_SYSTEM,
    user: buildPromptBUser({ ...opts, oldL2 }),
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
    const row = await upsertL2({
      id: item.id || undefined,
      periodStart: parseMaybeTime(opts.periodStart, now - 86_400_000),
      periodEnd: parseMaybeTime(opts.periodEnd, now),
      text: item.text,
    });
    written.push({ id: row.id, time: item.time, text: row.text });
  }
  await writeJournal("process", {
    step: "B",
    note: `${written.length} 条 L2`,
    raw: result.text.slice(0, 4000),
  });
  return written;
}

async function rewriteState(opts: {
  periodStart: string;
  periodEnd: string;
  newL2: Array<{ id: string; time: string; text: string }>;
  clock: (ms: number) => string;
  now: number;
}): Promise<void> {
  const [oldL2, oldL3, portrait, opens] = await Promise.all([
    loadL2(),
    loadL3(),
    loadPortrait(),
    loadOpenThreads(),
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
      openDraft: opens.map((item) => item.text).join("；"),
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
  await writeJournal("process", {
    step: "C",
    note: `规律 ${parsed.patterns.length} 条`,
    raw: result.text.slice(0, 4000),
  });
}

async function pickRelated(timeZone: string): Promise<void> {
  const clock = (ms: number) => formatClock(ms, timeZone);
  const messages = await loadAllMessages();
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser?.text.trim()) return;
  const items = await loadRetrievable();
  if (items.length === 0) {
    await saveMeta({ pickedIds: [] });
    return;
  }
  const result = await chatJson({
    system: PROMPT_D_SYSTEM,
    user: buildPromptDUser({
      brief: lastUser.text,
      candidates: items.slice(0, 80),
      clock,
    }),
    maxTokens: 400,
    timeoutMs: 12_000,
    temperature: 0.1,
  });
  if (!result.ok) {
    await appendLog("d_fail", result.error);
    return;
  }
  const ids = parsePickedIds(result.text, items.map((item) => item.id));
  await saveMeta({ pickedIds: ids });
  await writeJournal("process", {
    step: "D",
    note: `${ids.length} 条相关记忆`,
    raw: result.text.slice(0, 1000),
  });
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

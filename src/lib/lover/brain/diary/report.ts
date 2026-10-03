import { asModelInput, callModel } from "../llm.ts";
import { now } from "../clock.ts";
import { getSql } from "../../../db.ts";
import { getMeta, patchMeta, upsertReport } from "../store.ts";
import { localDay, monthRange } from "../time.ts";
import { loadFormats, loadPrompt } from "../prompts/store.ts";
import { DEFAULT_FORMATS, fmt, type Formats } from "../prompts/formats.ts";
import { parsePromptBody, renderVariant } from "../prompts/doc.ts";
import { lockedProfile } from "../../types.ts";
import { fromStored, modelFacingText } from "../../message-meta.ts";
import { enqueue } from "../jobs.ts";

/**
 * The monthly report: reads the month's daily timelines (qr_days, written by the mind and the night pass)
 * and the month's conversation, and writes one reading for Rosie. Qingran never reads it.
 */
const CHUNK_CHARS = 12_000;

export type MonthLine = { day: string; role: "user" | "assistant"; text: string };

/** This month's spoken turns. System notices and forgotten rows stay out. */
export async function loadMonthDialogue(month: string, f: Formats = DEFAULT_FORMATS): Promise<MonthLine[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) return [];
  const { start, end } = monthRange(month);
  const db = await getSql();
  const rows = await db.query<{ role: string; body: string; meta: unknown; local_day: string | null }>(
    `select role, body, meta, local_day
     from qingran_messages
     where forgotten_at is null
       and kind is distinct from 'system_notice'
       and local_day >= $1 and local_day <= $2
     order by created_at asc, id asc`,
    [start, end],
  );
  return rows
    .map((row) => ({
      day: String(row.local_day ?? ""),
      role: row.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: modelFacingText(fromStored(row.body, row.meta), f).replace(/\s+/g, " ").trim(),
    }))
    .filter((row) => row.day && row.text);
}

export function chunkByDay(lines: MonthLine[], maxChars = CHUNK_CHARS, f: Formats = DEFAULT_FORMATS): string[] {
  const days: Array<{ day: string; text: string }> = [];
  for (const line of lines) {
    const who = line.role === "user" ? "Rosie" : "清然";
    const row = fmt(f, "reportLine", { who, text: line.text });
    const last = days[days.length - 1];
    if (last?.day === line.day) last.text = `${last.text}\n${row}`;
    else days.push({ day: line.day, text: row });
  }
  const chunks: string[] = [];
  let buf = "";
  const push = (block: string) => {
    for (let i = 0; i < block.length; i += maxChars) chunks.push(block.slice(i, i + maxChars));
  };
  for (const day of days) {
    const block = `${fmt(f, "reportDay", { day: day.day })}\n${day.text}`;
    if (buf && buf.length + block.length + 2 > maxChars) {
      push(buf);
      buf = "";
    }
    if (block.length > maxChars) {
      push(block);
      continue;
    }
    buf = buf ? `${buf}\n\n${block}` : block;
  }
  if (buf) push(buf);
  return chunks;
}

async function completeVariant(variantId: string, vars: Record<string, string>, jobId?: string): Promise<string> {
  const reportPrompt = await loadPrompt("report");
  const result = await callModel("report", {
    ...asModelInput(renderVariant(parsePromptBody("report", reportPrompt.body), variantId, vars)),
    jobId,
    promptKey: reportPrompt.key,
    promptHash: reportPrompt.hash,
  });
  return result.text.trim();
}

async function monthTimelines(start: string, end: string, f: Formats): Promise<string> {
  const db = await getSql();
  const rows = await db.query<{ day: string; timeline: string }>(
    `select day, timeline from qr_days where day >= $1 and day <= $2 and timeline <> '' order by day asc`,
    [start, end],
  );
  return rows.map((r) => fmt(f, "reportTimeline", { day: r.day, timeline: String(r.timeline).trim() })).join("\n\n");
}

export async function runReport(month: string, jobId?: string): Promise<void> {
  if (!/^\d{4}-\d{2}$/.test(month)) return;
  const { start, end } = monthRange(month);
  const formats = await loadFormats();
  const lines = await loadMonthDialogue(month, formats);
  if (!lines.length) {
    await upsertReport({
      id: month,
      periodStart: start,
      periodEnd: end,
      data: { month, empty: true, source: "messages" },
      narrative: "这个月没有对话。",
      createdAt: now(),
    });
    await patchMeta({ lastReportMonth: month });
    return;
  }
  const chunks = chunkByDay(lines, CHUNK_CHARS, formats);
  let summaries = chunks[0] ?? "";
  if (chunks.length > 1) {
    const parts: string[] = [];
    for (const chunk of chunks) {
      const digest = await completeVariant("digest", { chunk }, jobId);
      if (digest) parts.push(digest);
    }
    summaries = parts.join("\n\n");
  }
  const timelines = await monthTimelines(start, end, formats);
  const text = await completeVariant("main", { timelines: timelines.slice(0, 15_000), summaries: summaries.slice(0, 25_000) }, jobId);
  await upsertReport({
    id: month,
    periodStart: start,
    periodEnd: end,
    data: { month, source: "messages", chunks: chunks.length },
    narrative: text.replace(/\n{3,}/g, "\n\n").trim() || "没写成。",
    createdAt: now(),
  });
  await patchMeta({ lastReportMonth: month });
}

function previousMonth(nowMs: number, timeZone: string): string {
  const [y, m] = localDay(nowMs, timeZone).split("-").map(Number) as [number, number];
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return `${prev.y}-${String(prev.m).padStart(2, "0")}`;
}

/** On the 1st of a month (diary switch on), queue last month's report once. */
export async function enqueueReportIfDue(nowMs: number, timeZone: string): Promise<void> {
  const { getProfileData } = await import("../store.ts");
  const profile = lockedProfile(await getProfileData());
  if (!profile.diaryEnabled) return;
  const meta = await getMeta();
  if (meta.timeZone !== timeZone) await patchMeta({ timeZone });
  if (localDay(nowMs, timeZone).slice(8) !== "01") return;
  const month = previousMonth(nowMs, timeZone);
  if (meta.lastReportMonth < month) await enqueue("report", `report:${month}`, { month });
}

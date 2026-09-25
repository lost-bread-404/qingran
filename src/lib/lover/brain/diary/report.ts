import { asModelInput, callModel } from "../llm.ts";
import { now } from "../clock.ts";
import { getSql } from "../../../db.ts";
import {
  listDays,
  listEpisodes,
  listExperiments,
  listFactors,
  listFindings,
  listIntentions,
  listThemes,
  listThemeWeeks,
  patchMeta,
  upsertReport,
} from "../store.ts";
import { daysInclusive, isoWeek, monthRange, shiftDay } from "../time.ts";
import { loadPrompt } from "../prompts/store.ts";
import { parsePromptBody, renderVariant } from "../prompts/doc.ts";
import { narrativeNumbersOk } from "./report-check.ts";
import { safetyFlag, sayDoByTag, stuckLoops } from "./stats.ts";

const CHUNK_CHARS = 12_000;

export type MonthLine = { day: string; role: "user" | "assistant"; text: string };

/** This month's spoken turns. System notices and forgotten rows stay out. */
export async function loadMonthDialogue(month: string): Promise<MonthLine[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) return [];
  const { start, end } = monthRange(month);
  const db = await getSql();
  const rows = await db.query<{ role: string; body: string; local_day: string | null }>(
    `select role, body, local_day
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
      role: row.role === "assistant" ? "assistant" as const : "user" as const,
      text: String(row.body ?? "").replace(/\s+/g, " ").trim(),
    }))
    .filter((row) => row.day && row.text);
}

export function chunkByDay(lines: MonthLine[], maxChars = CHUNK_CHARS): string[] {
  const days: Array<{ day: string; text: string }> = [];
  for (const line of lines) {
    const who = line.role === "user" ? "Rosie" : "清然";
    const row = `${who}：${line.text}`;
    const last = days[days.length - 1];
    if (last?.day === line.day) last.text = `${last.text}\n${row}`;
    else days.push({ day: line.day, text: row });
  }
  const chunks: string[] = [];
  let buf = "";
  const push = (block: string) => {
    if (block.length <= maxChars) {
      chunks.push(block);
      return;
    }
    for (let i = 0; i < block.length; i += maxChars) chunks.push(block.slice(i, i + maxChars));
  };
  for (const day of days) {
    const block = `【${day.day}】\n${day.text}`;
    if (buf && buf.length + block.length + 2 > maxChars) {
      push(buf);
      buf = "";
    }
    if (block.length > maxChars) {
      if (buf) push(buf);
      buf = "";
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

export async function buildReportData(month: string) {
  const { start, end } = monthRange(month);
  const days = await listDays(start, end);
  const factors = await listFactors(true);
  const episodes = await listEpisodes();
  const findings = (await listFindings()).filter((f) => f.userFeedback !== "rejected");
  const intentions = await listIntentions();
  const themes = await listThemes(true);
  const weeks = await listThemeWeeks();
  const experiments = await listExperiments();
  const byTheme: Record<string, Array<{ week: string; mentions: number; actionTaken: number | null }>> = {};
  for (const w of weeks) {
    byTheme[w.themeId] ??= [];
    byTheme[w.themeId]!.push({ week: w.week, mentions: w.mentions, actionTaken: w.actionTaken });
  }
  const recentWeeks = [...new Set(days.map((d) => isoWeek(d.day)))].sort();
  const low = factors.find((f) => f.name === "情绪低落");
  const lowEps = episodes.filter((e) => e.factorId === (low?.id ?? "seed-情绪低落"));
  const allDays = daysInclusive(start, end);
  const ok = days.filter((d) => d.coverage === "ok").length;
  return {
    month,
    periodStart: start,
    periodEnd: end,
    curve: days.map((d) => ({
      day: d.day,
      energy: d.energy,
      mood: d.mood,
      coverage: d.coverage,
      lastActive: d.lastActive,
    })),
    episodes: episodes.filter((e) => e.startDay <= end && (e.endDay ?? e.startDay) >= start),
    sayDo: sayDoByTag(intentions),
    stuck: stuckLoops(byTheme, recentWeeks).map((s) => ({
      ...s,
      name: themes.find((t) => t.id === s.themeId)?.name ?? s.themeId,
    })),
    findings: findings.filter((f) => f.tier === "finding"),
    clues: findings.filter((f) => f.tier === "clue"),
    antecedents: findings.filter((f) => f.kind === "antecedent" && f.tier === "finding").slice(0, 5),
    recovery: findings.filter((f) => f.kind === "recovery").slice(0, 3).map((f) => ({ ...f, clue: true })),
    wins: days.flatMap((d) => d.wins.map((w) => ({ day: d.day, text: w.text }))),
    themes: themes.map((t) => ({
      id: t.id,
      name: t.name,
      mentions: (byTheme[t.id] ?? []).reduce((s, w) => s + w.mentions, 0),
    })),
    experiments: experiments.filter((e) => e.startDay <= end),
    safety_flag: safetyFlag(lowEps, end),
    coverage: allDays.length ? ok / allDays.length : 0,
    okDays: ok,
    monthDays: allDays.length,
  };
}

export async function writeNarrative(summaries: string, jobId?: string): Promise<string> {
  const text = await completeVariant("main", { summaries: summaries.slice(0, 20_000), data: summaries.slice(0, 20_000) }, jobId);
  return text.replace(/\n{3,}/g, "\n\n").trim().slice(0, 800);
}

export async function runReport(month: string, jobId?: string): Promise<void> {
  if (!/^\d{4}-\d{2}$/.test(month)) return;
  const { start, end } = monthRange(month);
  const lines = await loadMonthDialogue(month);
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
  const chunks = chunkByDay(lines);
  let summaries = chunks[0] ?? "";
  if (chunks.length > 1 || summaries.length > CHUNK_CHARS) {
    const parts: string[] = [];
    for (const chunk of chunks) {
      const digest = await completeVariant("digest", { chunk, summaries: chunk, data: chunk }, jobId);
      if (digest) parts.push(digest);
    }
    summaries = parts.join("\n\n");
  }
  const { dayNotes, groupByDay } = await import("../day-notes.ts");
  const { getMeta } = await import("../store.ts");
  const { resolveTz } = await import("../tz.ts");
  const tz = resolveTz((await getMeta()).timeZone);
  const days = groupByDay(await dayNotes(Date.parse(`${start}T08:00:00Z`), Date.parse(`${end}T08:00:00Z`) + 24 * 3_600_000), tz);
  const table = days.length ? `【每天的记录】（清然随手记下的，带时间）\n${days.map((d) => `${d.day}\n${d.lines.join("\n")}`).join("\n\n")}\n\n` : "";
  const narrative = await writeNarrative(`${table}【对话摘要】\n${summaries}`, jobId);
  await upsertReport({
    id: month,
    periodStart: start,
    periodEnd: end,
    data: { month, source: "messages", chunks: chunks.length },
    narrative: narrative || "没写成。",
    createdAt: now(),
  });
  await patchMeta({ lastReportMonth: month });
}

export { narrativeNumbersOk, shiftDay, CHUNK_CHARS };

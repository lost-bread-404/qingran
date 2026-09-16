import { callModel } from "../llm.ts";
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
import { proposeExperiments } from "./experiments.ts";
import { NARRATIVE_RULES } from "./prompts.ts";
import { narrativeNumbersOk } from "./report-check.ts";
import { safetyFlag, sayDoByTag, stuckLoops } from "./stats.ts";

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
    antecedents: findings.filter((f) => f.kind === "antecedent").slice(0, 5),
    recovery: findings.filter((f) => f.kind === "recovery").slice(0, 3),
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

export async function writeNarrative(data: unknown, jobId?: string): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const result = await callModel("report", {
      system: NARRATIVE_RULES,
      input: JSON.stringify(data).slice(0, 20_000),
      jobId,
    });
    const text = result.text.replace(/\s+/g, " ").trim().slice(0, 800);
    if (text && narrativeNumbersOk(text, data)) return text;
  }
  return "";
}

export async function runReport(month: string, jobId?: string): Promise<void> {
  if (!/^\d{4}-\d{2}$/.test(month)) return;
  const data = await buildReportData(month);
  await proposeExperiments(data, jobId);
  const narrative = await writeNarrative(data, jobId);
  const { start, end } = monthRange(month);
  await upsertReport({
    id: month,
    periodStart: start,
    periodEnd: end,
    data,
    narrative,
    createdAt: Date.now(),
  });
  await patchMeta({ lastReportMonth: month });
}

export { narrativeNumbersOk, shiftDay };

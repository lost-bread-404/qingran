import { now as wallClock } from "../clock.ts";
import {
  listDayFactors,
  listFactors,
  listFindings,
  listThemeWeeks,
  replaceEpisodes,
  upsertFinding,
} from "../store.ts";
import { buildEpisodes, computeAllFindings, seriesFromDayFactors } from "./stats.ts";

/** Pure code. No model calls. Safe to run at the end of every dusk. */
export async function recomputeStats(): Promise<void> {
  const factors = await listFactors(true);
  const dayFactors = await listDayFactors();
  const themeWeeks = await listThemeWeeks();
  const ts = wallClock();
  const days = [...new Set(dayFactors.map((d) => d.day))].sort();
  const episodes = factors
    .filter((f) => f.isOutcome)
    .flatMap((f) => buildEpisodes(f.id, seriesFromDayFactors(dayFactors, f.id), days, ts));
  await replaceEpisodes(episodes);
  const findings = computeAllFindings({
    factors,
    dayFactors,
    themeWeeks: themeWeeks.map((w) => ({ themeId: w.themeId, week: w.week, mentions: w.mentions })),
    now: ts,
  });
  const existing = await listFindings();
  const rejected = new Set(existing.filter((f) => f.userFeedback === "rejected").map((f) => f.id));
  for (const f of findings) {
    if (rejected.has(f.id)) continue;
    const prev = existing.find((e) => e.id === f.id);
    await upsertFinding({ ...f, userFeedback: prev?.userFeedback ?? null });
  }
}

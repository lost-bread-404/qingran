import { isGoldSource } from "./gold.ts";

export type CoverageClip = {
  category?: string | null;
  mode?: string | null;
  gold_source?: string | null;
  storage_backend?: string | null;
};

export type CoverageBucket = { confirmed: number; edited: number; n: number };

function bump(map: Record<string, CoverageBucket>, key: string, source: string | null | undefined) {
  const row = (map[key] ??= { confirmed: 0, edited: 0, n: 0 });
  row.n += 1;
  if (source === "confirmed") row.confirmed += 1;
  if (source === "edited") row.edited += 1;
}

export function summarizeCoverage(clips: CoverageClip[], totalTurns: number) {
  const labeled = clips.filter((c) => isGoldSource(c.gold_source));
  const byCategory: Record<string, CoverageBucket> = {};
  const byMode: Record<string, CoverageBucket> = {};
  for (const clip of labeled) {
    bump(byCategory, clip.category || "未分类", clip.gold_source);
    bump(byMode, clip.mode || "unknown", clip.gold_source);
  }
  const thinCategories = Object.entries(byCategory)
    .filter(([, v]) => v.n < 5)
    .map(([k]) => k)
    .sort();
  return {
    totalClips: clips.length,
    confirmed: labeled.filter((c) => c.gold_source === "confirmed").length,
    edited: labeled.filter((c) => c.gold_source === "edited").length,
    labeled: labeled.length,
    confirmationRate: totalTurns > 0 ? labeled.length / totalTurns : 0,
    byCategory,
    byMode,
    thinCategories,
    dbBacked: clips.filter((c) => c.storage_backend === "db").length,
  };
}

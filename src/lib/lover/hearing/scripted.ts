import {
  SCRIPTED_CATEGORIES,
  type ScriptedCategoryId,
  type ScriptedCategory,
} from "./config.ts";

export function isScriptedCategoryId(value: unknown): value is ScriptedCategoryId {
  return typeof value === "string" && SCRIPTED_CATEGORIES.some((c) => c.id === value);
}

export function sanitizeSkipped(list: unknown): ScriptedCategoryId[] {
  if (!Array.isArray(list)) return [];
  const out: ScriptedCategoryId[] = [];
  for (const item of list) {
    if (isScriptedCategoryId(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

export function effectiveQuota(cat: ScriptedCategory, skipped: readonly string[]): number {
  return skipped.includes(cat.id) ? 0 : cat.quota;
}

export function countsFromQuotaRows(rows: { id: string; have: number }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.id] = row.have;
  return counts;
}

export function bumpScriptedCount(have: Record<string, number>, id: string): Record<string, number> {
  return { ...have, [id]: (have[id] ?? 0) + 1 };
}

export function nextScriptedCategory(
  counts: Record<string, number>,
  skipped: readonly string[] = [],
): ScriptedCategory | null {
  for (const cat of SCRIPTED_CATEGORIES) {
    const quota = effectiveQuota(cat, skipped);
    if (quota <= 0) continue;
    if ((counts[cat.id] ?? 0) < quota) return cat;
  }
  return null;
}

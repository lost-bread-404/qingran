import { SCRIPTED_CATEGORIES, type ScriptedCategoryId } from "./config.ts";

export type ScriptedCountRow = { id: string; have: number; quota?: number };

const PG_ERROR_KEYS = ["code", "detail", "hint", "position", "where", "column", "table"] as const;

export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) {
    const extra = err as Error & Record<string, unknown>;
    const bits = [extra.message];
    for (const key of PG_ERROR_KEYS) {
      if (extra[key] != null && extra[key] !== "") bits.push(`${key}=${String(extra[key])}`);
    }
    return bits.join(" | ");
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function hearingSaveError(err: unknown): string {
  console.error("[hearing] insertClip failed:", err);
  if (err && typeof err === "object") {
    const extra = err as Record<string, unknown>;
    for (const key of PG_ERROR_KEYS) {
      if (extra[key] != null) console.error(`[hearing]   ${key}:`, extra[key]);
    }
  }
  return formatUnknownError(err);
}

export function clipSaveBanner(saveError: string): string {
  return `录音没存上：${saveError}`;
}

export function persistHearingClip(session: {
  debugHearing?: boolean;
  capture?: boolean;
  scripted?: boolean;
}): boolean {
  return Boolean(session.debugHearing || session.capture || session.scripted);
}

export function shouldForwardToQingran(scripted: boolean): boolean {
  return !scripted;
}

export function shouldShowUnheardHint(scripted: boolean, text: string): boolean {
  return !scripted && !text.trim();
}

export function shouldSaveEmptyTranscript(source: "real" | "scripted"): boolean {
  return source === "scripted";
}

export function effectiveQuota(category: { id: string; quota: number }, skipped: readonly string[]): number {
  return skipped.includes(category.id) ? 0 : category.quota;
}

export function countsFromQuotaRows(rows: readonly ScriptedCountRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.id] = Number(row.have) || 0;
  return counts;
}

export function bumpScriptedCount(counts: Record<string, number>, category: string): Record<string, number> {
  return { ...counts, [category]: (counts[category] ?? 0) + 1 };
}

export function nextScriptedCategory(
  counts: Record<string, number>,
  skipped: readonly string[] = [],
): (typeof SCRIPTED_CATEGORIES)[number] | null {
  for (const cat of SCRIPTED_CATEGORIES) {
    const quota = effectiveQuota(cat, skipped);
    if (quota <= 0) continue;
    if ((counts[cat.id] ?? 0) < quota) return cat;
  }
  return null;
}

export function isScriptedCategoryId(value: string): value is ScriptedCategoryId {
  return SCRIPTED_CATEGORIES.some((c) => c.id === value);
}

export function parseSkippedScripted(value: unknown): ScriptedCategoryId[] {
  if (!Array.isArray(value)) return [];
  const out: ScriptedCategoryId[] = [];
  for (const item of value) {
    if (typeof item === "string" && isScriptedCategoryId(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

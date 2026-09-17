import type { HearingProviderId, ScriptedCategoryId } from "./config.ts";
import { DEFAULT_HEARING_PROVIDER, SCRIPTED_CATEGORIES } from "./config.ts";

export type HearingSource = "real" | "scripted";

export type HearingSession = {
  provider: HearingProviderId;
  capture: boolean;
  scripted: boolean;
  source: HearingSource;
  category: ScriptedCategoryId | null;
  turnId: string | null;
  lastTurnId: string | null;
  coldStartMs: number | null;
};

const session: HearingSession = {
  provider: DEFAULT_HEARING_PROVIDER,
  capture: false,
  scripted: false,
  source: "real",
  category: null,
  turnId: null,
  lastTurnId: null,
  coldStartMs: null,
};

export function getHearingSession(): HearingSession {
  return session;
}

export function setHearingSession(patch: Partial<HearingSession>) {
  Object.assign(session, patch);
  if (session.scripted) session.source = "scripted";
  else session.source = "real";
}

export function nextScriptedCategory(
  counts: Record<string, number>,
): (typeof SCRIPTED_CATEGORIES)[number] | null {
  for (const cat of SCRIPTED_CATEGORIES) {
    if ((counts[cat.id] ?? 0) < cat.quota) return cat;
  }
  return null;
}

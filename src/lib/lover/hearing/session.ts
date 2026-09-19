import type { HearingProviderId, ScriptedCategoryId } from "./config.ts";
import { DEFAULT_HEARING_PROVIDER } from "./config.ts";
import type { AudioRoute, HearingMode } from "./route.ts";
export { nextScriptedCategory } from "./scripted.ts";

export type HearingSource = "real" | "scripted";

export type HearingSession = {
  provider: HearingProviderId;
  capture: boolean;
  scripted: boolean;
  source: HearingSource;
  category: ScriptedCategoryId | null;
  turnId: string | null;
  lastTurnId: string | null;
  lastClipId: string | null;
  lastSaveError: string | null;
  lastXaiText: string | null;
  coldStartMs: number | null;
  debugHearing: boolean;
  nbest: boolean;
  mode: HearingMode;
  audioRoute: AudioRoute;
  context: string;
  extraKeyterms: string[];
};

const session: HearingSession = {
  provider: DEFAULT_HEARING_PROVIDER,
  capture: false,
  scripted: false,
  source: "real",
  category: null,
  turnId: null,
  lastTurnId: null,
  lastClipId: null,
  lastSaveError: null,
  lastXaiText: null,
  coldStartMs: null,
  debugHearing: true,
  nbest: false,
  mode: "text",
  audioRoute: "unknown",
  context: "",
  extraKeyterms: [],
};

export function getHearingSession(): HearingSession {
  return session;
}

export function setHearingSession(patch: Partial<HearingSession>) {
  Object.assign(session, patch);
  if (session.scripted) session.source = "scripted";
  else session.source = "real";
}

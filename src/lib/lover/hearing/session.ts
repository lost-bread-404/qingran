import type { HearingProviderId } from "./config.ts";
import { DEFAULT_HEARING_PROVIDER } from "./config.ts";
import type { ContextTurn } from "./context.ts";
import type { AudioRoute, HearingMode } from "./route.ts";

export type HearingSession = {
  provider: HearingProviderId;
  capture: boolean;
  turnId: string | null;
  lastTurnId: string | null;
  coldStartMs: number | null;
  debugHearing: boolean;
  nbest: boolean;
  mode: HearingMode;
  audioRoute: AudioRoute;
  context: string;
  extraKeyterms: string[];
  contextBefore: ContextTurn[];
  systemPrompt: string;
};

const session: HearingSession = {
  provider: DEFAULT_HEARING_PROVIDER,
  capture: false,
  turnId: null,
  lastTurnId: null,
  coldStartMs: null,
  debugHearing: true,
  nbest: false,
  mode: "text",
  audioRoute: "unknown",
  context: "",
  extraKeyterms: [],
  contextBefore: [],
  systemPrompt: "",
};

export function getHearingSession(): HearingSession {
  return session;
}

export function setHearingSession(patch: Partial<HearingSession>) {
  Object.assign(session, patch);
}
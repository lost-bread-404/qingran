import type { HearingProviderId } from "./config.ts";
import { DEFAULT_HEARING_PROVIDER, STT_KEYTERMS } from "./config.ts";
import type { ContextTurn } from "./context.ts";
import { DEFAULT_HEARING_SENSE, type HearingSense } from "./sense.ts";
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
  silenceMs: number;
  nightMode: boolean;
  nightVoicedMin: number;
  nightMinMs: number;
  sense: HearingSense;
  hearingInstruction: string;
  sttKeyterms: string[];
  /** performance.now() when Qingran last stopped speaking. Infinity while she is speaking. */
  floorQuietAt: number;
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
  silenceMs: DEFAULT_HEARING_SENSE.endWaitMs,
  nightMode: true,
  nightVoicedMin: DEFAULT_HEARING_SENSE.voicedMin,
  nightMinMs: DEFAULT_HEARING_SENSE.noiseMinMs,
  sense: DEFAULT_HEARING_SENSE,
  hearingInstruction: "",
  sttKeyterms: [...STT_KEYTERMS],
  floorQuietAt: 0,
};

export function getHearingSession(): HearingSession {
  return session;
}

export function setHearingSession(patch: Partial<HearingSession>) {
  Object.assign(session, patch);
}
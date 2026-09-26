export type InnerPlanStatus = "open" | "done" | "dropped";
export type InnerScene = "daily" | "intimate";
export type JobType = "reflect" | "report" | "wake" | "night";
export type JobStatus = "pending" | "running" | "done" | "failed";

export type InnerPlan = {
  id: string;
  what: string;
  /** Why he wants this. Old rows may still have trigger / expires_at; those are not used. */
  why: string;
  status: InnerPlanStatus;
  trigger?: string;
  expires_at?: number;
};

export type LongingItem = {
  id: string;
  text: string;
  since: string;
};

/** Private inner state. The reply sees desire / feel / now / glow word only. */
export type InnerState = {
  desire: string;
  readHer: string;
  feel: string;
  /** Legacy column. Not written. Copied into desire by 0030. */
  want: string;
  choice: string;
  now: string;
  scene: InnerScene;
  /** Joined from longings so older callers still have a single string. */
  longing: string;
  longings: LongingItem[];
  plans: InnerPlan[];
  glow: number;
  glow_at: number;
  turn_seq: number;
  updated_at: number;
  longing_updated_at: number;
};

export const EMPTY_INNER: InnerState = {
  desire: "",
  readHer: "",
  feel: "",
  want: "",
  choice: "",
  now: "",
  scene: "daily",
  longing: "",
  longings: [],
  plans: [],
  glow: 0,
  glow_at: 0,
  turn_seq: 0,
  updated_at: 0,
  longing_updated_at: 0,
};

export type BrainMeta = {
  selfSummary: string;
  bondSummary: string;
  notesVersion: number;
  lastDuskDay: string;
  lastSynthWeek: string;
  lastReportMonth: string;
  timeZone: string;
  hygieneMemoryLoopAt?: number;
  coreIndex?: { version: number; day: string; ids: string[] };
  spendLimits?: {
    daySoft: number;
    dayHard: number;
    dayBreaker: number;
    monthSoft: number;
    monthHard: number;
    monthBreaker: number;
  };
};

export const EMPTY_META: BrainMeta = {
  selfSummary: "",
  bondSummary: "",
  notesVersion: 0,
  lastDuskDay: "",
  lastSynthWeek: "",
  lastReportMonth: "",
  timeZone: "America/New_York",
};

export type BrainJob = {
  id: string;
  type: JobType;
  dedupeKey: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  runAfter: number;
  lockedUntil: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type BrainLogRow = {
  id: number;
  jobId: string | null;
  step: string;
  ok: boolean;
  ms: number | null;
  inputChars: number | null;
  raw: string | null;
  note: string | null;
  at: number;
  route?: string | null;
  model?: string | null;
  effort?: string | null;
  turnSeq?: number | null;
  tokensIn?: number | null;
  tokensCached?: number | null;
  tokensOut?: number | null;
  tokensReasoning?: number | null;
  costUsd?: number | null;
  error?: string | null;
  trimmed?: boolean;
  promptKey?: string | null;
  promptHash?: string | null;
  outputText?: string | null;
  inputSystem?: string | null;
  inputUser?: string | null;
};

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  kind: "say" | "steer" | "setting" | "proactive" | "system_notice";
  archivedAt: number | null;
  sessionId: string | null;
  localDay: string | null;
};

export type VoiceChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};


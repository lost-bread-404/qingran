export type Subject = "rosie" | "qingran" | "us";
export type Lens = "diary" | "bond";
export type NoteStatus = "active" | "superseded" | "archived" | "pending";
export type JobType = "reflect" | "archive" | "dusk" | "synth" | "report" | "backfill" | "editor" | "wake" | "busy" | "night";
export type JobStatus = "pending" | "running" | "done" | "failed";

export type Note = {
  id: string;
  text: string;
  tags: string[];
  aliases: string[];
  subject: Subject;
  lens: Lens[];
  fromRosie: boolean;
  weight: number;
  status: NoteStatus;
  supersededBy: string | null;
  links: string[];
  happenedAt: number;
  localDay: string;
  sourceIds: string[];
  recallCount: number;
  lastRecalledAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type Mind = {
  turn_seq: number;
  insight: string;
  memory_ids: string[];
  updated_at?: number;
};

export const EMPTY_MIND: Mind = {
  turn_seq: 0,
  insight: "",
  memory_ids: [],
};

export type InnerPlanStatus = "open" | "done" | "dropped";

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

export type InnerScene = "daily" | "intimate";

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

export type PortraitKind = "trait" | "episode" | "seed";
export type PortraitStatus = "active" | "stale" | "superseded";

export type PortraitRow = {
  id: string;
  topic: string;
  body: string;
  status: PortraitStatus;
  kind: PortraitKind;
  evidenceIds: string[];
  lastSeen: number;
  lastSupportedAt: number;
  supportCount: number;
  updatedAt: number;
  /** Filled for the settings page. Not stored. */
  evidenceCount?: number;
  evidenceFrom?: string | null;
  evidenceTo?: string | null;
  retireReason?: string | null;
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

export type DayLog = {
  day: string;
  summary: string;
  energy: number | null;
  mood: number | null;
  body: string | null;
  did: Array<{ text: string; intention_id?: string }>;
  avoided: Array<{ text: string }>;
  events: Array<{ text: string }>;
  wins: Array<{ text: string }>;
  firstActive: number | null;
  lastActive: number | null;
  msgCount: number;
  coverage: "none" | "thin" | "ok";
  noteIds: string[];
  version: number;
  updatedAt: number;
};

export type Intention = {
  id: string;
  text: string;
  tag: string | null;
  statedAt: number;
  targetDay: string | null;
  status: "open" | "started" | "done" | "dropped";
  startedAt: number | null;
  doneAt: number | null;
  lastEvidenceAt: number;
  evidenceIds: string[];
  updatedAt: number;
};

export type Factor = {
  id: string;
  name: string;
  definition: string;
  version: number;
  isOutcome: boolean;
  status: "active" | "retired";
  origin: "seed" | "synth" | "user";
  userFeedback: string | null;
  createdAt: number;
  updatedAt: number;
};

export type DayFactor = {
  day: string;
  factorId: string;
  version: number;
  value: 1 | 0 | null;
  evidenceIds: string[];
};

export type Theme = {
  id: string;
  name: string;
  definition: string;
  version: number;
  status: "active" | "merged" | "retired";
  mergedInto: string | null;
  parentId: string | null;
  userFeedback: string | null;
  createdAt: number;
  updatedAt: number;
};

export type Finding = {
  id: string;
  kind: "antecedent" | "recovery" | "cooccur";
  outcomeId: string;
  antecedentId: string;
  lag: number;
  n11: number;
  n10: number;
  n01: number;
  n00: number;
  lift: number;
  score: number;
  exampleDays: string[];
  counterDays: string[];
  userFeedback: string | null;
  computedAt: number;
  tier: "finding" | "clue";
};

export type Episode = {
  id: string;
  factorId: string;
  startDay: string;
  endDay: string | null;
  endKnown: boolean;
  days: number;
  evidenceIds: string[];
  computedAt: number;
};

export type ExperimentResult = {
  complianceDays: number;
  skippedDays: number;
  outcomeWhenDone: number | null;
  outcomeWhenSkipped: number | null;
  baseline28: number | null;
  insufficient: boolean;
};

export type Experiment = {
  id: string;
  hypothesis: string;
  action: string;
  outcomeId: string;
  complianceFactorId: string | null;
  startDay: string;
  endDay: string;
  status: "proposed" | "active" | "done" | "abandoned";
  result: ExperimentResult | null;
  createdAt: number;
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

export type IndexItem = {
  id: string;
  text: string;
  searchText: string;
  subject: Subject;
  lens: Lens[];
  weight: number;
  happenedAt: number;
  localDay: string;
  recallCount: number;
  score: number;
};

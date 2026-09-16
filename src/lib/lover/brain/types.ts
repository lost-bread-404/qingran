export type Subject = "rosie" | "qingran" | "us";
export type Lens = "diary" | "bond";
export type NoteStatus = "active" | "superseded" | "archived";
export type JobType = "reflect" | "archive" | "dusk" | "synth" | "report" | "backfill";
export type JobStatus = "pending" | "running" | "done" | "failed";

export type Note = {
  id: string;
  text: string;
  tags: string[];
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

export type MindReading = { guess: string; conf: number };

export type Mind = {
  turn_seq: number;
  rosie_now: string;
  undercurrent: string;
  reading: MindReading[];
  soft_spot: string;
  my_feel: string;
  my_view: string;
  my_logic: string;
  lead_plan: string[];
  intent: string;
  threads: string[];
  recent_intents: string[];
  memory_ids: string[];
};

export const EMPTY_MIND: Mind = {
  turn_seq: 0,
  rosie_now: "",
  undercurrent: "",
  reading: [],
  soft_spot: "",
  my_feel: "",
  my_view: "",
  my_logic: "",
  lead_plan: [],
  intent: "",
  threads: [],
  recent_intents: [],
  memory_ids: [],
};

export type PortraitRow = {
  id: string;
  topic: string;
  body: string;
  status: "active" | "dormant";
  evidenceIds: string[];
  lastSeen: number;
  updatedAt: number;
};

export type BrainMeta = {
  selfSummary: string;
  bondSummary: string;
  notesVersion: number;
  lastDuskDay: string;
  lastSynthWeek: string;
  lastReportMonth: string;
  timeZone: string;
};

export const EMPTY_META: BrainMeta = {
  selfSummary: "",
  bondSummary: "",
  notesVersion: 0,
  lastDuskDay: "",
  lastSynthWeek: "",
  lastReportMonth: "",
  timeZone: "UTC",
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
};

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  kind: "say" | "steer" | "setting";
  archivedAt: number | null;
  sessionId: string | null;
  localDay: string | null;
};

export type VoiceChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type IndexItem = {
  id: string;
  text: string;
  subject: Subject;
  lens: Lens[];
  weight: number;
  happenedAt: number;
  localDay: string;
  recallCount: number;
  score: number;
};

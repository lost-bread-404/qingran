export type JobType = "report" | "wake" | "night";
export type JobStatus = "pending" | "running" | "done" | "failed";

export type BrainMeta = {
  lastReportMonth: string;
  timeZone: string;
};

export const EMPTY_META: BrainMeta = {
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
  kind: "say" | "proactive" | "system_notice";
  archivedAt: number | null;
  sessionId: string | null;
  localDay: string | null;
};

export type VoiceChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  /** Photos she sent with this line (qr_photos ids); turned into images when the reply is asked. */
  images?: string[];
};


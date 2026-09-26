import {
  type AcousticTags,
  type TagAccuracy,
  type TagKey,
} from "./tags.ts";

export const EVAL_BATCH_SIZE = 10;
export const EVAL_STATUSES = ["ok", "hard_refusal", "soft_refusal", "timeout", "error"] as const;
export type EvalRunStatus = (typeof EVAL_STATUSES)[number];

export type EvalJob = { clipId: string; engine: string };

export type EvalBatchWindow = {
  start: number;
  end: number;
  count: number;
  nextOffset: number;
  done: boolean;
  total: number;
};

export type EvalScoreRow = {
  engine: string;
  text: string;
  tags?: AcousticTags | null;
  latencyMs?: number | null;
  status: string;
  goldText: string;
  goldTags?: Partial<AcousticTags> | null;
  tagsTouched?: TagKey[] | null;
};

export type EvalRefusalCounts = {
  hard_refusal: number;
  soft_refusal: number;
  timeout: number;
  error: number;
};

export type EngineEvalScore = {
  engine: string;
  n: number;
  okN: number;
  cer: number | null;
  exactMatch: number | null;
  refusals: EvalRefusalCounts;
  tagAccuracy: TagAccuracy;
  latencyP50: number | null;
  latencyP95: number | null;
};


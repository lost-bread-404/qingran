import { cer, percentile, textsExact } from "./metrics.ts";
import type { HearingFailReason } from "./select.ts";
import {
  emptyEventScores,
  parseAcousticTags,
  scoreTagAccuracy,
  type AcousticTags,
  type TagAccuracy,
  type TagKey,
} from "./tags.ts";
import type { HearingProviderId } from "./config.ts";

export const EVAL_BATCH_SIZE = 10;
export const EVAL_STATUSES = ["ok", "hard_refusal", "soft_refusal", "timeout", "error"] as const;
export type EvalRunStatus = (typeof EVAL_STATUSES)[number];

export type EvalJob = { clipId: string; engine: HearingProviderId };

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

export function isEvalRunStatus(value: unknown): value is EvalRunStatus {
  return typeof value === "string" && (EVAL_STATUSES as readonly string[]).includes(value);
}

export function statusFromFailReason(reason: HearingFailReason): EvalRunStatus {
  if (reason === "timeout") return "timeout";
  if (reason === "refusal") return "hard_refusal";
  if (reason === "schema") return "soft_refusal";
  return "error";
}

export function statusFromXaiError(error: string): EvalRunStatus {
  if (/timeout|aborted/i.test(error)) return "timeout";
  return "error";
}

export function evalJobs(clipIds: string[], engines: HearingProviderId[]): EvalJob[] {
  const jobs: EvalJob[] = [];
  for (const clipId of clipIds) {
    for (const engine of engines) jobs.push({ clipId, engine });
  }
  return jobs;
}

export function evalBatchWindow(input: {
  total: number;
  offset: number;
  batchSize?: number;
}): EvalBatchWindow {
  const batchSize = input.batchSize ?? EVAL_BATCH_SIZE;
  const total = Math.max(0, Math.floor(input.total));
  const start = Math.min(total, Math.max(0, Math.floor(input.offset)));
  const end = Math.min(total, start + Math.max(1, batchSize));
  return {
    start,
    end,
    count: Math.max(0, end - start),
    nextOffset: end,
    done: end >= total,
    total,
  };
}

export function emptyEngineEval(engine: string): EngineEvalScore {
  return {
    engine,
    n: 0,
    okN: 0,
    cer: null,
    exactMatch: null,
    refusals: { hard_refusal: 0, soft_refusal: 0, timeout: 0, error: 0 },
    tagAccuracy: {
      length: null,
      contour: null,
      voice: null,
      events: emptyEventScores(),
    },
    latencyP50: null,
    latencyP95: null,
  };
}

export function scoreEngineEval(rows: EvalScoreRow[]): EngineEvalScore {
  const engine = rows[0]?.engine || "xai";
  const out = emptyEngineEval(engine);
  out.n = rows.length;
  const ok = rows.filter((row) => row.status === "ok");
  out.okN = ok.length;
  for (const row of rows) {
    if (row.status === "hard_refusal") out.refusals.hard_refusal += 1;
    else if (row.status === "soft_refusal") out.refusals.soft_refusal += 1;
    else if (row.status === "timeout") out.refusals.timeout += 1;
    else if (row.status === "error") out.refusals.error += 1;
  }
  if (ok.length) {
    out.cer = mean(ok.map((row) => cer(row.goldText, row.text)));
    out.exactMatch = ok.filter((row) => textsExact(row.goldText, row.text)).length / ok.length;
    out.tagAccuracy = scoreTagAccuracy(
      ok.map((row) => ({
        predictedTags: row.tags,
        goldTags: row.goldTags,
        tagsTouched: row.tagsTouched,
      })),
    );
  }
  const latencies = rows
    .map((row) => row.latencyMs)
    .filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms));
  if (latencies.length) {
    out.latencyP50 = percentile(latencies, 50);
    out.latencyP95 = percentile(latencies, 95);
  }
  return out;
}

export function scoreEngineEvalByEngine(rows: EvalScoreRow[], engines?: string[]): EngineEvalScore[] {
  const grouped = new Map<string, EvalScoreRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.engine) ?? [];
    list.push(row);
    grouped.set(row.engine, list);
  }
  const ids = engines?.length ? engines : [...grouped.keys()];
  return ids.map((engine) => {
    const list = grouped.get(engine);
    return list?.length ? scoreEngineEval(list) : emptyEngineEval(engine);
  });
}

export function parseEvalTags(value: unknown): AcousticTags | null {
  return parseAcousticTags(value);
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

import {
  DRAIN_BUDGET_MS,
  JOB_MAX_ATTEMPTS,
  MANUAL_DRAIN_MS,
} from "./config.ts";
import { canStartJob, retryDelayMs } from "./jobs-policy.ts";
import {
  claimJob,
  cleanupOldJobs,
  finishJob,
  insertJob,
  newerReflectExists,
  restoreClaim,
  skipOldReflect,
} from "./store.ts";
import { newId } from "../storage.ts";
import type { BrainJob, JobType } from "./types.ts";

export { canStartJob } from "./jobs-policy.ts";

export async function enqueue(
  type: JobType,
  dedupeKey: string,
  payload: Record<string, unknown> = {},
  runAfter = Date.now(),
  force = false,
): Promise<boolean> {
  const job: BrainJob = {
    id: newId(),
    type,
    dedupeKey,
    payload,
    status: "pending",
    attempts: 0,
    runAfter,
    lockedUntil: null,
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return insertJob(job, force);
}

async function runOne(job: BrainJob): Promise<void> {
  if (job.type === "reflect") {
    const turnSeq = Number(job.payload.turnSeq ?? 0);
    if (await newerReflectExists(turnSeq)) {
      await finishJob(job.id, "done");
      return;
    }
    const { runReflector } = await import("./voice/reflector");
    await runReflector(turnSeq, job.id);
    await finishJob(job.id, "done");
    return;
  }
  if (job.type === "archive") {
    const { runArchivist } = await import("./archivist");
    const ids = Array.isArray(job.payload.ids) ? (job.payload.ids as string[]) : [];
    await runArchivist(ids, job.id);
    await finishJob(job.id, "done");
    return;
  }
  if (job.type === "dusk") {
    const { runDusk } = await import("./diary/dusk");
    await runDusk(String(job.payload.day ?? ""), job.id);
    await finishJob(job.id, "done");
    return;
  }
  if (job.type === "synth") {
    const { runSynth } = await import("./diary/synth");
    await runSynth(String(job.payload.week ?? ""), job.id);
    await finishJob(job.id, "done");
    return;
  }
  if (job.type === "report") {
    const { runReport } = await import("./diary/report");
    await runReport(String(job.payload.month ?? ""), job.id);
    await finishJob(job.id, "done");
    return;
  }
  if (job.type === "backfill") {
    const { runBackfill } = await import("./diary/synth");
    await runBackfill(String(job.payload.factorId ?? ""), job.id);
    await finishJob(job.id, "done");
    return;
  }
  await finishJob(job.id, "failed", { error: `unknown type ${job.type}` });
}

export async function drainJobs(budgetMs = DRAIN_BUDGET_MS): Promise<number> {
  const started = Date.now();
  let ran = 0;
  await cleanupOldJobs(started);
  while (Date.now() - started < budgetMs) {
    const remaining = budgetMs - (Date.now() - started);
    const job = await claimJob(Date.now(), Math.max(remaining, 5_000));
    if (!job) break;
    if (!canStartJob(job.type, remaining)) {
      await restoreClaim(job.id, job.attempts);
      break;
    }
    try {
      await runOne(job);
      ran += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (job.attempts < JOB_MAX_ATTEMPTS) {
        const delay = retryDelayMs(job.attempts);
        await finishJob(job.id, "pending", { runAfter: Date.now() + delay, error: message });
      } else {
        await finishJob(job.id, "failed", { error: message });
      }
    }
  }
  return ran;
}

export async function runJobsNow(types: JobType[]): Promise<number> {
  const now = Date.now();
  for (const type of types) {
    await enqueue(type, `manual:${type}:${now}`, { manual: true }, now, true);
  }
  return drainJobs(MANUAL_DRAIN_MS);
}

export { skipOldReflect };

import {
  DRAIN_BUDGET_MS,
  JOB_MAX_ATTEMPTS,
  LOCK_SLACK_MS,
  LONG_DRAIN_MS,
} from "./config.ts";
import { now } from "./clock.ts";
import { canStartJob, retryDelayMs, timeoutFor } from "./jobs-policy.ts";
import {
  claimJob,
  cleanupOldJobs,
  deferJob,
  deferPendingUntil,
  finishJob,
  insertJob,
  peekNextJob,
  restoreClaim,
} from "./store.ts";
import { newId } from "../storage.ts";
import type { BrainJob, JobType } from "./types.ts";
import { SPEND_RATE_ERR } from "./spend/rate.ts";

export { canStartJob } from "./jobs-policy.ts";

export async function enqueue(
  type: JobType,
  dedupeKey: string,
  payload: Record<string, unknown> = {},
  runAfter = now(),
  force = false,
): Promise<boolean> {
  const ts = now();
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
    createdAt: ts,
    updatedAt: ts,
  };
  return insertJob(job, force);
}

async function runOne(job: BrainJob): Promise<void> {
  if (job.type === "report") {
    const { runReport } = await import("./diary/report");
    await runReport(String(job.payload.month ?? ""), job.id);
    await finishJob(job.id, "done");
    return;
  }
  if (job.type === "night") {
    const { runNight } = await import("./night");
    await runNight(String(job.payload.day ?? ""), job.id);
    await finishJob(job.id, "done");
    return;
  }
  if (job.type === "wake") {
    const { runWake } = await import("./reach");
    await runWake();
    await finishJob(job.id, "done");
    return;
  }
  await finishJob(job.id, "failed", { error: `unknown type ${job.type}` });
}

export async function drainJobs(budgetMs = DRAIN_BUDGET_MS): Promise<number> {
  const wall0 = Date.now();
  let ran = 0;
  await cleanupOldJobs(now());
  while (Date.now() - wall0 < budgetMs) {
    const remaining = budgetMs - (Date.now() - wall0);
    const peek = await peekNextJob(now());
    if (!peek) break;
    if (!canStartJob(peek.type, remaining)) {
      await deferJob(peek.id, now() + Math.max(remaining, 1_000), "wait-budget");
      continue;
    }
    const job = await claimJob(now(), timeoutFor(peek.type) + LOCK_SLACK_MS, peek.id);
    if (!job) continue;
    try {
      await runOne(job);
      ran += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === SPEND_RATE_ERR || (err as { code?: string }).code === SPEND_RATE_ERR) {
        await restoreClaim(job.id, job.attempts);
        await deferPendingUntil(now() + 10 * 60_000, "spend-rate");
        break;
      }
      if (job.attempts < JOB_MAX_ATTEMPTS) {
        const delay = retryDelayMs(job.attempts);
        await finishJob(job.id, "pending", { runAfter: now() + delay, error: message });
      } else {
        await finishJob(job.id, "failed", { error: message });
        // A day that keeps failing is set aside, so the days after it still get their night pass.
        if (job.type === "night" && job.payload.day) {
          const { setMark } = await import("./memory.ts");
          await setMark(`day:${String(job.payload.day)}`, "failed").catch(() => undefined);
        }
      }
    }
  }
  return ran;
}

/** 手动 / Diary / cron：调用方负责先 enqueue，这里只负责在长预算内 drain。 */
export async function runJobsNow(budgetMs = LONG_DRAIN_MS): Promise<number> {
  return drainJobs(budgetMs);
}

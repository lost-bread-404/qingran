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
  finishReflectJob,
  insertJob,
  peekNextJob,
  restoreClaim,
  upsertReflectJob,
} from "./store.ts";
import { newId } from "../storage.ts";
import type { BrainJob, JobType } from "./types.ts";
import { checkSpend } from "./spend/check.ts";
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
  const inserted = type === "reflect" && !force
    ? (await upsertReflectJob(Number(payload.turnSeq ?? 0)), true)
    : await insertJob(job, force);
  return inserted;
}

async function runOne(job: BrainJob): Promise<void> {
  if (job.type === "reflect") {
    const turnSeq = Number(job.payload.turnSeq ?? 0);
    const { runReflector } = await import("./voice/reflector");
    await runReflector(turnSeq, job.id);
    await finishReflectJob(job.id, turnSeq);
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
    await runDusk(String(job.payload.day ?? ""), job.id, { manual: Boolean(job.payload.manual) });
    await finishJob(job.id, "done");
    return;
  }
  if (job.type === "synth") {
    const { runSynth } = await import("./diary/synth");
    await runSynth(String(job.payload.week ?? ""), job.id, { manual: Boolean(job.payload.manual) });
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
  if (job.type === "editor") {
    const reason = String(job.payload.reason ?? "turns");
    if (reason === "activate") {
      const { ensureDossierLive } = await import("./dossier");
      await ensureDossierLive();
    } else {
      const { runEditor } = await import("./dossier");
      await runEditor(reason);
    }
    await finishJob(job.id, "done");
    return;
  }
  if (job.type === "wake") {
    const { runWake } = await import("./reach");
    await runWake();
    await finishJob(job.id, "done");
    return;
  }
  if (job.type === "busy") {
    const { generateBusySchedule, busyRefreshNeeded } = await import("./busy");
    if (await busyRefreshNeeded()) await generateBusySchedule();
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
    const hold = await checkSpend(peek.type);
    if (!hold.allow) {
      await deferJob(peek.id, hold.resumeAt ?? now() + 3_600_000, `spend:${hold.level}`);
      continue;
    }
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
      if (job.type === "reflect") {
        const turnSeq = Number(job.payload.turnSeq ?? 0);
        if ((await finishReflectJob(job.id, turnSeq)) === "pending") continue;
      }
      if (job.attempts < JOB_MAX_ATTEMPTS) {
        const delay = retryDelayMs(job.attempts);
        await finishJob(job.id, "pending", { runAfter: now() + delay, error: message });
      } else {
        await finishJob(job.id, "failed", { error: message });
      }
    }
  }
  return ran;
}

/** 手动 / Diary / cron：调用方负责先 enqueue，这里只负责在长预算内 drain。 */
export async function runJobsNow(budgetMs = LONG_DRAIN_MS): Promise<number> {
  return drainJobs(budgetMs);
}

export { upsertReflectJob };

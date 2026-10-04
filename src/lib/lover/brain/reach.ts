import { stripSpeechTags } from "../speech-tags.ts";
import { isClaudeModel } from "../claude.ts";
import { callModel } from "./llm.ts";
import { appendBrainLog, getProfileData, upsertMessage } from "./store.ts";
import { now } from "./clock.ts";
import { REACH_LLM_DAY_MAX, REACH_RETRY_MS, REACH_SENT_DAY_MAX } from "./life.ts";
import { sendApns } from "../push/apns.ts";
import { newId } from "../storage.ts";
import { getSql } from "../../db.ts";
import { lockedProfile } from "../types.ts";
import { getReach, insertReachLog, profileClockZone, reachCountsToday, saveReach } from "./life-store.ts";
import { getInner, lastUserAt, setReachStage } from "./heart.ts";

export type WakeResult = {
  ok: boolean;
  sent: boolean;
  brain: string[];
  decision: { action: "call"; trigger: "silence" | "manual" } | { action: "return"; reason: string };
};

/**
 * How long she has been quiet when he thinks of her (requirements 第 5 节): once at each step, never on a timetable.
 * After the last step he thinks of her once a day. Each time, the voice that answers her decides whether to write.
 */
const SILENCE_STEPS_MS = [45 * 60_000, 3 * 3600_000, 8 * 3600_000, 20 * 3600_000];
const DAY_MS = 24 * 3600_000;

export function silenceStep(quietMs: number): number {
  let step = 0;
  for (const t of SILENCE_STEPS_MS) if (quietMs >= t) step += 1;
  const last = SILENCE_STEPS_MS[SILENCE_STEPS_MS.length - 1]!;
  if (quietMs >= last + DAY_MS) step += Math.floor((quietMs - last) / DAY_MS);
  return step;
}

const WAKE_LOCK = "wake:lock";

export async function claimWakeLock(at = now(), lockMs = 120_000): Promise<boolean> {
  const db = await getSql();
  const until = at + lockMs;
  const updated = await db.query<{ id: string }>(
    `update brain_jobs
     set status = 'running', locked_until = $2, updated_at = $1, attempts = attempts + 1, type = 'wake'
     where dedupe_key = $3 and (status <> 'running' or locked_until is null or locked_until < $1)
     returning id`,
    [at, until, WAKE_LOCK],
  );
  if (updated.length) return true;
  const inserted = await db.query<{ id: string }>(
    `insert into brain_jobs (id, type, dedupe_key, payload, status, attempts, run_after, locked_until, created_at, updated_at)
     values ($1, 'wake', $2, '{}'::jsonb, 'running', 1, $3, $4, $3, $3)
     on conflict (dedupe_key) do nothing
     returning id`,
    [newId(), WAKE_LOCK, at, until],
  );
  return inserted.length > 0;
}

export async function releaseWakeLock(at = now()): Promise<void> {
  const db = await getSql();
  await db.query(
    `update brain_jobs set status = 'done', locked_until = null, updated_at = $1 where dedupe_key = $2`,
    [at, WAKE_LOCK],
  );
}

/**
 * Every 5 minutes (cron-job.org → /api/cron/wake), only while memory is on:
 * 1. one ended day that is not in his memory yet gets its night pass (queued; it runs after the response);
 * 2. if she has been quiet long enough for the next step, he thinks of her once and may write to her.
 */
export async function runWake(opts: { manual?: boolean; at?: number; complete?: typeof callModel } = {}): Promise<WakeResult> {
  const at = opts.at ?? now();
  const zone = await profileClockZone();
  const profile = lockedProfile(await getProfileData());
  const brain: string[] = [];
  const skip = (reason: string): WakeResult => ({ ok: true, sent: false, brain, decision: { action: "return", reason } });
  if (!profile.brainOn) return skip("brain_off");

  if (!opts.manual) {
    const { enqueueMemoryWork } = await import("./night.ts");
    const night = await enqueueMemoryWork(at);
    if (night) brain.push(`night:${night}`);
  }

  const [reach, last, inner, counts] = await Promise.all([getReach(), lastUserAt(at + 1), getInner(), reachCountsToday(zone, at)]);
  const trigger: "silence" | "manual" = opts.manual ? "manual" : "silence";
  let step = 0;
  if (!opts.manual) {
    if (!last) return skip("never_talked");
    step = silenceStep(at - last);
    const seen = inner.silenceSeen === last ? inner.reachStage : 0;
    if (step <= seen) return skip(step ? "thought_already" : "chatting");
    if (!reach.enabled) {
      await setReachStage(last, step);
      return skip("disabled");
    }
    if (counts.llm >= REACH_LLM_DAY_MAX || counts.sent >= REACH_SENT_DAY_MAX) {
      await setReachStage(last, step);
      await appendBrainLog({ step: "reach-breaker", ok: false, route: "voice", note: `当天想起她 ${counts.llm} 次，发出 ${counts.sent} 条` });
      await insertReachLog({ at, trigger: "skip:breaker", calledLlm: false, sent: false });
      return skip("breaker");
    }
    // One thought per step, even if the call fails (a failure gets one retry below).
    await setReachStage(last, step);
  }

  const { speakFirst } = await import("./voice/first-word.ts");
  const spoken = await speakFirst({ nowMs: at, timeZone: zone, lastUserAt: last ?? null });
  if (!spoken.text && !spoken.passed) {
    const reason = spoken.reason ?? "出错";
    if (!opts.manual && reach.retry < 1 && last) {
      // Try this step once more on a later wake.
      await saveReach({ retry: 1 });
      await setReachStage(last, step - 1);
      await insertReachLog({ at, trigger: `skip:llm_fail:${reason}`, calledLlm: true, sent: false, model: spoken.model, ms: spoken.ms, nextAt: at + REACH_RETRY_MS });
      return { ok: false, sent: false, brain, decision: { action: "call", trigger } };
    }
    const id = newId();
    await upsertMessage({ id, role: "assistant", text: `清然尝试给你发信息，但是因为${reason}没发成功。`, createdAt: at, kind: "system_notice", timeZone: zone });
    await saveReach({ retry: 0 });
    await insertReachLog({ at, trigger: `skip:llm_fail:${reason}`, calledLlm: true, sent: false, messageId: id, model: spoken.model, ms: spoken.ms });
    return { ok: false, sent: false, brain, decision: { action: "call", trigger } };
  }
  if (reach.retry) await saveReach({ retry: 0 });
  let messageId: string | null = null;
  let pushResult: string | null = null;
  if (spoken.text) {
    messageId = newId();
    await upsertMessage({
      id: messageId,
      role: "assistant",
      text: spoken.text,
      createdAt: at,
      kind: "proactive",
      timeZone: zone,
      meta: { engine: isClaudeModel(spoken.model) ? "claude" : "grok", ...(spoken.engine === "grok" ? { scene: "grok" as const } : {}) },
    });
    pushResult = await sendApns({ body: stripSpeechTags(spoken.text), messageId });
    // Claude wrote to her after a while apart and it is sent: the scene is over, Claude plays her from now on
    // (docs/claude-grok-routing.md). Not if she spoke while it was being written (she may be back in the scene).
    if (profile.claudeRouting && isClaudeModel(spoken.model) && (await lastUserAt(Date.now() + 1)) === (last ?? null)) {
      const { endScene } = await import("./voice/engine.ts");
      await endScene();
    }
  }
  await insertReachLog({
    at,
    trigger: spoken.passed ? `${trigger}:不找` : trigger,
    calledLlm: true,
    sent: Boolean(spoken.text),
    messageId,
    text: spoken.text,
    pushResult,
    model: spoken.model,
    ms: spoken.ms,
  });
  return { ok: true, sent: Boolean(spoken.text), brain, decision: { action: "call", trigger } };
}

export async function wakeOnce(opts: Parameters<typeof runWake>[0] = {}): Promise<Awaited<ReturnType<typeof runWake>> | { ok: true; skipped: "locked" }> {
  const got = await claimWakeLock(opts.at ?? now(), 300_000);
  if (!got) return { ok: true, skipped: "locked" };
  try {
    return await runWake(opts);
  } finally {
    await releaseWakeLock(now());
  }
}

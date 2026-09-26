import { callModel } from "./llm.ts";
import { appendBrainLog, getProfileData, upsertMessage } from "./store.ts";
import { now } from "./clock.ts";
import { localDay, shiftDay } from "./time.ts";
import { zonedWallMs } from "./spend/policy.ts";
import { REACH_LLM_DAY_MAX, REACH_RETRY_MS, REACH_SENT_DAY_MAX } from "./life.ts";
import { sendApns } from "../push/apns.ts";
import { newId } from "../storage.ts";
import { getSql } from "../../db.ts";
import { lockedProfile } from "../types.ts";
import {
  delayReachPlans,
  finishReachPlans,
  getReach,
  insertReachLog,
  profileClockZone,
  reachCountsToday,
  saveReach,
  silenceSnapshot,
} from "./life-store.ts";
import { ACTIVE_MS, formatLocal, getHeart, lastUserAt, listPlans, markSilenceSeen, SILENCE_THINK_MS } from "./heart.ts";

export type WakeResult = {
  ok: boolean;
  sent: boolean;
  brain: string[];
  decision: { action: "call"; trigger: "planned" | "manual" } | { action: "return"; reason: string };
};

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

function failReasonZh(kind: string | null | undefined): string {
  const k = kind ?? "";
  if (k.startsWith("timeout")) return "xAI 超时";
  if (k.startsWith("parse")) return "回复没法读";
  if (k.startsWith("http_error")) return "xAI 报错";
  return "没连上";
}

function ago(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} 小时`;
  return `${Math.round(h / 24)} 天`;
}

/** What came due is handled either way (sent, or he let it go): every pending plan whose time has passed is done. */
async function finishDuePlans(at: number): Promise<void> {
  const db = await getSql();
  await db.query(`update qr_reach_plans set done_at = $1 where done_at is null and at is not null and at <= $1`, [at]);
}

/**
 * Every 5 minutes (cron-job.org → /api/cron/wake), only while the brain is on:
 * 1. after 04:00 the day that ended gets its night pass; a silence of 45 minutes gets one thought;
 * 2. plans whose time has come: she is in the chat → they stay for the mind, which may make one the reply's focus;
 *    she is away → the mind thinks again (「到时间了」) and decides whether to send her one message.
 */
export async function runWake(opts: {
  manual?: boolean;
  at?: number;
  complete?: typeof callModel;
  llmMax?: number;
  sentMax?: number;
} = {}): Promise<WakeResult> {
  const at = opts.at ?? now();
  const zone = await profileClockZone();
  const profile = lockedProfile(await getProfileData());
  const complete = opts.complete ?? callModel;
  const brain: string[] = [];
  const skip = (reason: string): WakeResult => ({ ok: true, sent: false, brain, decision: { action: "return", reason } });
  if (!profile.brainOn) return skip("brain_off");

  if (!opts.manual) {
    const { enqueueNightIfDue } = await import("./night.ts");
    const night = await enqueueNightIfDue(at);
    if (night) brain.push(`night:${night}`);
    const [last, heart] = await Promise.all([lastUserAt(at + 1), getHeart()]);
    if (last && at - last >= SILENCE_THINK_MS && heart.silenceSeen < last) {
      // One thought per silence, even if the call fails.
      await markSilenceSeen(last);
      const { runReflector } = await import("./voice/reflector.ts");
      await runReflector(0, undefined, complete, { kind: "silence", silentSince: last, since: heart.silenceSeen });
      brain.push("silence");
    }
  }

  const [reach, plans, lastUser, silence, counts] = await Promise.all([
    getReach(),
    listPlans(),
    lastUserAt(at + 1),
    silenceSnapshot(at),
    reachCountsToday(zone, at),
  ]);
  const due = plans.filter((plan) => plan.at != null && plan.at <= at);
  const later = plans.filter((plan) => plan.at != null && plan.at > at).sort((x, y) => x.at! - y.at!);
  const dueIds = due.map((plan) => plan.id);
  const dueIntent = due.map((plan) => plan.text).filter(Boolean).join("；");
  const trigger: "planned" | "manual" = opts.manual ? "manual" : "planned";
  if (!opts.manual) {
    if (!due.length) return skip("not_due");
    // She is in the chat: the plans stay, and the mind sees them as 到时间了 after her next turn.
    if (lastUser != null && at - lastUser < ACTIVE_MS) return skip("chatting");
  }
  if (!reach.enabled) {
    await finishReachPlans(dueIds, at);
    await insertReachLog({ at, trigger: "skip:disabled", intent: dueIntent, calledLlm: false, sent: false, nextAt: later[0]?.at ?? null });
    return skip("disabled");
  }
  const llmMax = opts.llmMax ?? REACH_LLM_DAY_MAX;
  const sentMax = opts.sentMax ?? REACH_SENT_DAY_MAX;
  if (counts.llm >= llmMax || counts.sent >= sentMax) {
    const tomorrow = zonedWallMs(shiftDay(localDay(at, zone), 1), 8, 0, zone);
    await delayReachPlans(dueIds, tomorrow);
    await appendBrainLog({
      step: "reach-breaker",
      ok: false,
      route: "reflect",
      note: `当天想起她 ${counts.llm}/${llmMax} 次，发出 ${counts.sent}/${sentMax} 条`,
    });
    await insertReachLog({ at, trigger: "skip:breaker", intent: dueIntent, calledLlm: false, sent: false, nextAt: tomorrow });
    return skip("breaker");
  }

  const dueLines =
    trigger === "manual"
      ? "她要你现在想起她。"
      : `到时间的事：\n${due.map((plan) => `- ${plan.text || "（没写）"}${plan.setAt ? `（${ago(at - plan.setAt)}前定的）` : ""}`).join("\n")}`;
  const quiet = silence.lastUserAt
    ? `她最后一次说话是 ${ago(at - silence.lastUserAt)} 前。之后我已经发了 ${silence.unanswered} 条，她还没回${silence.lines.length ? `：\n${silence.lines.join("\n")}` : "。"}`
    : "她还没有说过话。";
  const laterText = later.length ? `\n之后还打算：\n${later.map((plan) => `- ${formatLocal(plan.at!, zone)} ${plan.text}`).join("\n")}` : "";

  const { runReflector } = await import("./voice/reflector.ts");
  const result = await runReflector(0, undefined, complete, { kind: "due", dueText: `${dueLines}\n${quiet}${laterText}` });
  if (!result.ok) {
    const reason = failReasonZh(result.failKind);
    if (reach.retry >= 1) {
      const id = newId();
      await upsertMessage({
        id,
        role: "assistant",
        text: `清然尝试给你发信息，但是因为${reason}没发成功。`,
        createdAt: at,
        kind: "system_notice",
        timeZone: zone,
      });
      await finishReachPlans(dueIds, at);
      await saveReach({ retry: 0 });
      await insertReachLog({ at, trigger: `skip:llm_fail:${reason}`, intent: dueIntent, calledLlm: true, sent: false, messageId: id, model: result.model, ms: result.ms, nextAt: null });
      return { ok: false, sent: false, brain, decision: { action: "call", trigger } };
    }
    const nextAt = at + REACH_RETRY_MS;
    await delayReachPlans(dueIds, nextAt);
    await saveReach({ retry: 1 });
    await insertReachLog({ at, trigger: `skip:llm_fail:${reason}`, intent: dueIntent, calledLlm: true, sent: false, model: result.model, ms: result.ms, nextAt });
    return { ok: false, sent: false, brain, decision: { action: "call", trigger } };
  }

  await finishReachPlans(dueIds, at);
  await finishDuePlans(at);
  if (reach.retry) await saveReach({ retry: 0 });
  // The mind decided whether to reach her and what for; the words come from the voice that answers her.
  const intent = result.message;
  let text = "";
  let messageId: string | null = null;
  let pushResult: string | null = null;
  if (intent) {
    const { speakFirst } = await import("./voice/first-word.ts");
    const spoken = await speakFirst({ intent, nowMs: at, timeZone: zone, lastUserAt: silence.lastUserAt ?? null });
    text = spoken.text;
    if (!text) {
      await upsertMessage({
        id: newId(),
        role: "assistant",
        text: `清然尝试给你发信息，但是因为${spoken.reason ?? "出错"}没发成功。`,
        createdAt: at,
        kind: "system_notice",
        timeZone: zone,
      });
    }
  }
  if (text) {
    messageId = newId();
    await upsertMessage({ id: messageId, role: "assistant", text, createdAt: at, kind: "proactive", timeZone: zone });
    pushResult = await sendApns({ body: text, messageId });
  }
  const next = (await listPlans()).filter((plan) => plan.at != null && plan.at > at).sort((x, y) => x.at! - y.at!)[0];
  await insertReachLog({
    at,
    trigger,
    intent: intent ? `${dueIntent} → ${intent}` : dueIntent,
    calledLlm: true,
    sent: Boolean(text),
    messageId,
    text,
    pushResult,
    nextAt: next?.at ?? null,
    nextIntent: next?.text ?? "",
    model: result.model,
    ms: result.ms,
  });
  return { ok: true, sent: Boolean(text), brain, decision: { action: "call", trigger } };
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

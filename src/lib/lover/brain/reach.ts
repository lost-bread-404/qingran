import { callModel } from "./llm.ts";
import { appendBrainLog, getProfileData, getProfilePrompt, listHistoryWindow, upsertMessage } from "./store.ts";
import { now } from "./clock.ts";
import { formatClock, localDay, shiftDay } from "./time.ts";
import { zonedWallMs } from "./spend/policy.ts";
import { parsePromptBody, personaAckText, renderVariant } from "./prompts/doc.ts";
import { loadPrompt } from "./prompts/store.ts";
import { dossierTextForModel } from "./dossier.ts";
import { identityBlock, REACH_LLM_DAY_MAX, REACH_RETRY_MS, REACH_SENT_DAY_MAX } from "./life.ts";
import { sendApns } from "../push/apns.ts";
import { newId } from "../storage.ts";
import { getSql } from "../../db.ts";
import { lockedProfile } from "../types.ts";
import { placePersona } from "./voice/pack-build.ts";
import { modelFacingText } from "../message-markup.ts";
import {
  delayReachPlans,
  finishReachPlans,
  getReach,
  insertReachLog,
  profileClockZone,
  reachCountsToday,
  readIdentity,
  saveReach,
  silenceSnapshot,
} from "./life-store.ts";
import { ACTIVE_MS, formatLocal, getHeart, lastUserAt, listPlans, markSilenceSeen, SILENCE_THINK_MS } from "./heart.ts";

const REACH_SCHEMA = {
  name: "reach",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["send", "text"],
    properties: {
      send: { type: "boolean" },
      text: { type: "string" },
    },
  },
};

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

function failReasonZh(kind: string | undefined): string {
  if (kind === "timeout") return "xAI 超时";
  if (kind === "parse_error") return "回复没法读";
  if (kind === "http_error") return "xAI 报错";
  return "没连上";
}

function ago(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} 小时`;
  return `${Math.round(h / 24)} 天`;
}

/**
 * Every 5 minutes (cron-job.org → /api/cron/wake):
 * 1. brain on: after 04:00 the day that ended gets its night pass; a silence of 45 minutes gets one thought.
 * 2. plans whose time has come: she is in the chat → they stay for the mind, which may make one the reply's focus;
 *    she is away → he decides whether to send one message, and the plans are done.
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

  if (profile.brainOn && !opts.manual) {
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
  const later = plans.filter((plan) => plan.at != null && plan.at > at);
  const dueIds = due.map((plan) => plan.id);
  const dueIntent = due.map((plan) => plan.text).filter(Boolean).join("；");
  const skip = async (reason: string, log: boolean): Promise<WakeResult> => {
    if (log) await insertReachLog({ at, trigger: `skip:${reason}`, intent: dueIntent, calledLlm: false, sent: false, nextAt: later[0]?.at ?? null });
    return { ok: true, sent: false, brain, decision: { action: "return", reason } };
  };
  if (!reach.enabled) return skip("disabled", dueIds.length > 0);
  const trigger: "planned" | "manual" = opts.manual ? "manual" : "planned";
  if (!opts.manual) {
    if (!due.length) return skip("not_due", false);
    if (lastUser != null && at - lastUser < ACTIVE_MS) return skip("chatting", false);
  }
  const llmMax = opts.llmMax ?? REACH_LLM_DAY_MAX;
  const sentMax = opts.sentMax ?? REACH_SENT_DAY_MAX;
  if (counts.llm >= llmMax || counts.sent >= sentMax) {
    const tomorrow = zonedWallMs(shiftDay(localDay(at, zone), 1), 8, 0, zone);
    await delayReachPlans(dueIds, tomorrow);
    await appendBrainLog({
      step: "reach-breaker",
      ok: false,
      route: "reach",
      note: `当天 reach 调用 ${counts.llm}/${llmMax}，发出 ${counts.sent}/${sentMax}`,
    });
    return skip("breaker", true);
  }

  const loaded = await loadPrompt("reach");
  const [dossier, heart, ident, charter, ackPrompt, history] = await Promise.all([
    dossierTextForModel(),
    getHeart(),
    readIdentity(),
    getProfilePrompt(),
    loadPrompt("persona_ack"),
    recentLines(zone),
  ]);
  const laterText = later.length
    ? `\n之后还打算：\n${later.map((plan) => `- ${formatLocal(plan.at!, zone)} ${plan.text || "（没写）"}`).join("\n")}`
    : "";
  const why =
    (trigger === "manual"
      ? "她要你现在想起她。"
      : due.map((plan) => `- ${plan.text || "（没写）"}${plan.setAt ? `（${ago(at - plan.setAt)}前定的）` : ""}`).join("\n")) + laterText;
  const silenceText = silence.lastUserAt
    ? `她最后一次说话是 ${ago(at - silence.lastUserAt)} 前。之后我已经发了 ${silence.unanswered} 条，她还没回：\n${silence.lines.join("\n") || "（没有）"}`
    : "她还没有说过话。";
  const block = identityBlock(ident.identity);
  const placed = placePersona(
    renderVariant(parsePromptBody("reach", loaded.body), "main", {
      system_prompt: profile.personaPlacement === "first_user" ? "" : charter,
      identity_block: block ? `${block}\n` : "",
      dossier: dossier.trim() || "（还没有）",
      clock: formatClock(at, zone),
      inner: heart.text.trim() || "（空）",
      why,
      silence: silenceText,
      conversation: history || "（还没有）",
    }),
    { placement: profile.personaPlacement, charter, ack: personaAckText(ackPrompt.body) },
  );
  const system = placed.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const users = placed.filter((message) => message.role !== "system").map((message) => message.content);
  const result = await complete("reach", {
    system,
    input: users[0] ?? "",
    inputParts: users,
    messages: placed,
    schema: REACH_SCHEMA,
    promptKey: loaded.key,
    promptHash: loaded.hash,
    outputRef: "reach",
  });
  if (!result.ok || !result.json || typeof result.json !== "object") {
    const failed = await failLlm(at, reach.retry, dueIds, failReasonZh(result.failKind), result.model, result.ms, trigger);
    return { ok: failed.ok, sent: false, brain, decision: { action: "call", trigger } };
  }
  const json = result.json as Record<string, unknown>;
  const text = json.send === true ? String(json.text ?? "").trim().slice(0, 2000) : "";
  // What came due is handled either way: sent, or he chose to let it go.
  await finishReachPlans(dueIds, at);
  if (reach.retry) await saveReach({ retry: 0 });
  let messageId: string | null = null;
  let pushResult: string | null = null;
  if (text) {
    messageId = newId();
    await upsertMessage({ id: messageId, role: "assistant", text, createdAt: at, kind: "proactive", timeZone: zone });
    pushResult = await sendApns({ body: text, messageId });
  }
  await insertReachLog({
    at,
    trigger,
    intent: dueIntent,
    calledLlm: true,
    sent: Boolean(text),
    messageId,
    text,
    pushResult,
    nextAt: later[0]?.at ?? null,
    nextIntent: later[0]?.text ?? "",
    model: result.model,
    ms: result.ms,
  });
  return { ok: true, sent: Boolean(text), brain, decision: { action: "call", trigger } };
}

async function failLlm(
  at: number,
  retry: number,
  dueIds: number[],
  reason: string,
  model: string,
  ms: number,
  _trigger: string,
): Promise<{ ok: boolean }> {
  if (retry >= 1) {
    const zone = await profileClockZone();
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
    await insertReachLog({
      at,
      trigger: `skip:llm_fail:${reason}`,
      calledLlm: true,
      sent: false,
      messageId: id,
      model,
      ms,
      nextAt: null,
    });
    return { ok: false };
  }
  const nextAt = at + REACH_RETRY_MS;
  await delayReachPlans(dueIds, nextAt);
  await saveReach({ retry: 1 });
  await insertReachLog({
    at,
    trigger: `skip:llm_fail:${reason}`,
    calledLlm: true,
    sent: false,
    model,
    ms,
    nextAt,
  });
  return { ok: false };
}

async function recentLines(zone: string): Promise<string> {
  const rows = await listHistoryWindow(null, 8);
  return rows
    .filter((row) => row.kind !== "system_notice")
    .map((row) => `[${formatClock(row.createdAt, zone)}] ${row.role === "user" ? "Rosie" : "清然"}：${modelFacingText(row.text)}`)
    .join("\n");
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

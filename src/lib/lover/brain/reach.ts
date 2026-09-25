import { callModel } from "./llm.ts";
import { appendBrainLog, getInner, getProfileData, getProfilePrompt, listHistoryWindow, upsertMessage } from "./store.ts";
import { now } from "./clock.ts";
import { formatClock, localDay, shiftDay } from "./time.ts";
import { zonedWallMs } from "./spend/policy.ts";
import { parsePromptBody, personaAckText, renderVariant } from "./prompts/doc.ts";
import { loadPrompt } from "./prompts/store.ts";
import { dossierTextForModel } from "./dossier.ts";
import {
  applyGlowDelta,
  busyContextLine,
  clampNextReachAt,
  decideWake,
  glowNow,
  glowWord,
  identityBlock,
  randomWakeProbability,
  REACH_LLM_DAY_MAX,
  REACH_RETRY_MS,
  REACH_SENT_DAY_MAX,
  CHAT_QUIET_MS,
  GLOW_HALF_LIFE_MS,
  type WakeDecision,
} from "./life.ts";
import { applyReflectOutput } from "./mind-parse.ts";
import { currentBusy } from "./busy.ts";
import { sendApns } from "../push/apns.ts";
import { newId } from "../storage.ts";
import { getSql } from "../../db.ts";
import { lockedProfile } from "../types.ts";
import { placePersona } from "./voice/pack-build.ts";
import {
  getReach,
  insertGlowEvent,
  insertReachLog,
  lastVisibleMessageAt,
  profileClockZone,
  reachCountsToday,
  readIdentity,
  saveReach,
  silenceSnapshot,
} from "./life-store.ts";

const REACH_SCHEMA = {
  name: "reach",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["send", "text", "desire", "read_her", "feel", "now", "scene", "longings", "glow", "next_reach"],
    properties: {
      send: { type: "boolean" },
      text: { type: "string" },
      desire: { type: "string" },
      read_her: { type: "string" },
      feel: { type: "string" },
      now: { type: "string" },
      scene: { type: "string", enum: ["daily", "intimate"] },
      longings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "text", "since"],
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            since: { type: "string" },
          },
        },
      },
      glow: {
        type: "object",
        additionalProperties: false,
        required: ["delta", "why"],
        properties: { delta: { type: "number" }, why: { type: "string" } },
      },
      next_reach: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["in_hours", "intent"],
            properties: { in_hours: { type: "number" }, intent: { type: "string" } },
          },
        ],
      },
    },
  },
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

export async function runWake(opts: {
  manual?: boolean;
  at?: number;
  roll?: number;
  complete?: typeof callModel;
  llmMax?: number;
  sentMax?: number;
} = {}): Promise<{ ok: boolean; decision: WakeDecision | { action: "return"; reason: string; log: boolean }; sent: boolean }> {
  const at = opts.at ?? now();
  const zone = await profileClockZone();
  const [reach, inner, ident, busy, lastAt, silence, counts] = await Promise.all([
    getReach(),
    getInner(),
    readIdentity(),
    currentBusy(at),
    lastVisibleMessageAt(),
    silenceSnapshot(at),
    reachCountsToday(zone, at),
  ]);
  const profile = lockedProfile(await getProfileData());
  const half = Math.round(profile.glowHalfLifeDays * 24 * 60 * 60 * 1000) || GLOW_HALF_LIFE_MS;
  const glow = glowNow(inner.glow, inner.glow_at, at, half);
  const decision = decideWake({
    enabled: reach.enabled,
    chatting: !opts.manual && lastAt != null && at - lastAt < CHAT_QUIET_MS,
    nextAt: reach.nextAt,
    now: at,
    roll: opts.roll ?? Math.random(),
    probability: randomWakeProbability({ glow, busy: busy.busy, longings: inner.longings.length }),
    llmToday: counts.llm,
    sentToday: counts.sent,
    tomorrowMorning: zonedWallMs(shiftDay(localDay(at, zone), 1), 8, 0, zone),
    manual: opts.manual,
    llmMax: opts.llmMax,
    sentMax: opts.sentMax,
  });
  if (decision.action === "return") {
    if (decision.log) {
      await insertReachLog({
        at,
        trigger: `skip:${decision.reason}`,
        intent: reach.intent,
        calledLlm: false,
        sent: false,
        nextAt: decision.nextAt ?? reach.nextAt,
      });
      if (decision.reason === "breaker" && decision.nextAt) {
        await saveReach({ nextAt: decision.nextAt, setBy: "reach", setAt: at, retry: 0, intent: reach.intent });
        await appendBrainLog({
          step: "reach-breaker",
          ok: false,
          route: "reach",
          note: `当天 reach 调用 ${counts.llm}/${opts.llmMax ?? REACH_LLM_DAY_MAX}，发出 ${counts.sent}/${opts.sentMax ?? REACH_SENT_DAY_MAX}`,
        });
      }
    }
    return { ok: true, decision, sent: false };
  }

  const loaded = await loadPrompt("reach");
  const dossier = await dossierTextForModel();
  const clock = formatClock(at, zone);
  const busyLine = busyContextLine(busy);
  const why = decision.trigger === "planned"
    ? `之前想好的：${reach.intent || "（没写）"}（${reach.setAt ? `${ago(at - reach.setAt)}前` : "刚刚"}）`
    : decision.trigger === "manual"
      ? "她要你现在想起她。"
      : "没有特别的事，就是想起你了。";
  const silenceText = silence.lastUserAt
    ? `你最后一次说话是 ${ago(at - silence.lastUserAt)} 前。之后我已经发了 ${silence.unanswered} 条，你都还没回：\n${silence.lines.join("\n") || "（没有）"}`
    : "你还没有说过话。";
  const history = await recentLines(zone);
  const word = glowWord(glow);
  const innerText = [
    inner.desire.trim() ? `想要：${inner.desire.trim()}` : "",
    inner.readHer.trim() ? `对她：${inner.readHer.trim()}` : "",
    inner.feel.trim() ? `心里：${inner.feel.trim()}` : "",
    word ? `心情：${word}（比平常）` : "",
    inner.longings.length
      ? `心事：\n${inner.longings.map((item) => `- ${item.text}${item.since ? `（从 ${item.since} 起）` : ""}`).join("\n")}`
      : "",
    inner.choice.trim() ? `取舍：${inner.choice.trim()}` : "",
    `场景：${inner.scene === "intimate" ? "intimate" : "daily"}`,
    inner.plans.filter((plan) => plan.status === "open").length
      ? `计划：\n${inner.plans.filter((plan) => plan.status === "open").map((plan) => `- ${plan.what}${plan.why ? `（${plan.why}）` : ""}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n");
  const block = identityBlock(ident.identity);
  const charter = await getProfilePrompt();
  const ack = personaAckText((await loadPrompt("persona_ack")).body);
  const placed = placePersona(
    renderVariant(parsePromptBody("reach", loaded.body), "main", {
      system_prompt: profile.personaPlacement === "first_user" ? "" : charter,
      identity_block: block ? `${block}\n` : "",
      dossier: dossier.trim() || "（还没有）",
      clock,
      busy_line: busyLine,
      inner: innerText || "（空）",
      why,
      silence: silenceText,
      conversation: history || "（还没有）",
    }),
    { placement: profile.personaPlacement, charter, ack },
  );
  const system = placed.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const users = placed.filter((message) => message.role !== "system").map((message) => message.content);
  const complete = opts.complete ?? callModel;
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
    return failLlm(at, reach.retry, failReasonZh(result.failKind), result.model, result.ms, decision.trigger);
  }
  const json = result.json as Record<string, unknown>;
  const applied = applyReflectOutput(inner, {
    desire: json.desire ?? json.want,
    read_her: json.read_her,
    feel: json.feel,
    want: json.want,
    choice: inner.choice,
    now: json.now,
    scene: json.scene,
    longings: json.longings,
    plans: inner.plans,
    glow: json.glow,
    next_reach: json.next_reach,
  }, at, inner.turn_seq);
  if (applied.glow && applied.glow.delta) {
    const nextGlow = applyGlowDelta(applied.next.glow, applied.next.glow_at, at, applied.glow.delta, half);
    applied.next.glow = nextGlow.glow;
    applied.next.glow_at = nextGlow.glowAt;
    if (nextGlow.event) {
      await insertGlowEvent({
        at,
        delta: applied.glow.delta,
        why: applied.glow.why,
        source: "reach",
        turnSeq: inner.turn_seq,
        glowAfter: nextGlow.glow,
      });
    }
  }
  await saveInnerForced(applied.next);
  const hours = applied.nextReach && typeof applied.nextReach === "object" ? applied.nextReach.inHours : applied.nextReach === null ? null : null;
  const intent = applied.nextReach && typeof applied.nextReach === "object" ? applied.nextReach.intent : "";
  const send = json.send === true && String(json.text ?? "").trim();
  const nextAt = hours == null ? null : clampNextReachAt(at, hours, silence.unanswered + (send ? 1 : 0));
  await saveReach({
    nextAt,
    intent,
    setBy: decision.trigger === "manual" ? "reach" : decision.trigger,
    setAt: at,
    retry: 0,
  });
  let messageId: string | null = null;
  let pushResult: string | null = null;
  if (send) {
    messageId = newId();
    const text = String(json.text).trim().slice(0, 2000);
    await upsertMessage({
      id: messageId,
      role: "assistant",
      text,
      createdAt: at,
      kind: "proactive",
      timeZone: zone,
    });
    pushResult = await sendApns({ body: text, messageId });
  }
  await insertReachLog({
    at,
    trigger: decision.trigger,
    intent: reach.intent,
    calledLlm: true,
    sent: Boolean(send),
    messageId,
    text: send ? String(json.text).trim().slice(0, 2000) : "",
    pushResult,
    nextAt,
    nextIntent: intent,
    model: result.model,
    ms: result.ms,
  });
  return { ok: true, decision, sent: Boolean(send) };
}

async function failLlm(
  at: number,
  retry: number,
  reason: string,
  model: string,
  ms: number,
  trigger: string,
): Promise<{ ok: boolean; decision: WakeDecision; sent: boolean }> {
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
    await saveReach({ nextAt: null, intent: "", setBy: "reach", setAt: at, retry: 0 });
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
    return { ok: false, decision: { action: "call", trigger: trigger as "planned" }, sent: false };
  }
  const nextAt = at + REACH_RETRY_MS;
  await saveReach({ nextAt, setBy: "reach", setAt: at, retry: 1 });
  await insertReachLog({
    at,
    trigger: `skip:llm_fail:${reason}`,
    calledLlm: true,
    sent: false,
    model,
    ms,
    nextAt,
  });
  return { ok: false, decision: { action: "call", trigger: trigger as "planned" }, sent: false };
}

async function recentLines(zone: string): Promise<string> {
  const rows = await listHistoryWindow(null, 8);
  return rows
    .filter((row) => row.kind !== "system_notice")
    .map((row) => `[${formatClock(row.createdAt, zone)}] ${row.role === "user" ? "Rosie" : "清然"}：${row.text}`)
    .join("\n");
}

async function saveInnerForced(inner: import("./types.ts").InnerState): Promise<void> {
  const db = await getSql();
  await db.query(
    `update qr_inner
     set feel = $1, desire = $2, read_her = $3, choice = $4, now_text = $5, scene = $6, longings = $7::jsonb, plans = $8::jsonb,
         updated_at = $9, longing_updated_at = $10, glow = $11, glow_at = $12
     where id = 1`,
    [
      inner.feel,
      inner.desire,
      inner.readHer,
      inner.choice,
      inner.now,
      inner.scene === "intimate" ? "intimate" : "daily",
      JSON.stringify(inner.longings ?? []),
      JSON.stringify(inner.plans),
      inner.updated_at,
      inner.longing_updated_at,
      inner.glow ?? 0,
      inner.glow_at ?? 0,
    ],
  );
}

export async function wakeOnce(opts: Parameters<typeof runWake>[0] = {}): Promise<Awaited<ReturnType<typeof runWake>> | { ok: true; skipped: "locked" }> {
  const got = await claimWakeLock(opts.at ?? now());
  if (!got) return { ok: true, skipped: "locked" };
  try {
    return await runWake(opts);
  } finally {
    await releaseWakeLock(now());
  }
}

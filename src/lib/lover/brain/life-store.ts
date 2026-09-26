import { getSql } from "../../db.ts";
import { now } from "./clock.ts";
import type { InnerPlan, InnerState, LongingItem } from "./types.ts";
import { localDay } from "./time.ts";
import { getMeta } from "./store.ts";
import { resolveTz } from "./tz.ts";
import { applyProfilePatch } from "../profile-patch.ts";
import { zonedWallMs } from "./spend/policy.ts";

function asInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

export type ReachRow = {
  nextAt: number | null;
  intent: string;
  setBy: string;
  setAt: number;
  enabled: boolean;
  retry: number;
};

export async function readIdentity(): Promise<{ identity: string; updatedAt: number; rhythm: string }> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select identity, identity_updated_at, rhythm, data from qingran_profile where id = 1`,
  );
  const row = rows[0];
  const data = row?.data && typeof row.data === "object" ? (row.data as Record<string, unknown>) : {};
  const column = String(row?.identity ?? "").trim();
  const fromJson = typeof data.identity === "string" ? data.identity.trim() : "";
  const rhythmCol = String(row?.rhythm ?? "").trim();
  const rhythmJson = typeof data.rhythm === "string" ? data.rhythm.trim() : "";
  return {
    identity: column || fromJson,
    updatedAt: asInt(row?.identity_updated_at),
    rhythm: rhythmCol || rhythmJson,
  };
}

export async function writeIdentity(identity: string, at = now()): Promise<void> {
  await applyProfilePatch({
    patch: { identity: identity.trim().slice(0, 2000) },
    force: true,
    source: "server",
    at,
  });
}

export async function getReach(): Promise<ReachRow> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select next_at, intent, set_by, set_at, enabled, retry from qr_reach where id = 1`,
  );
  const row = rows[0];
  return {
    nextAt: row?.next_at == null ? null : asInt(row.next_at),
    intent: String(row?.intent ?? ""),
    setBy: String(row?.set_by ?? ""),
    setAt: asInt(row?.set_at),
    enabled: row ? asBool(row.enabled) : true,
    retry: asInt(row?.retry),
  };
}

export async function saveReach(next: Partial<ReachRow> & { at?: number }): Promise<ReachRow> {
  const prev = await getReach();
  const row: ReachRow = {
    nextAt: next.nextAt === undefined ? prev.nextAt : next.nextAt,
    intent: next.intent === undefined ? prev.intent : next.intent,
    setBy: next.setBy === undefined ? prev.setBy : next.setBy,
    setAt: next.setAt === undefined ? prev.setAt : next.setAt,
    enabled: next.enabled === undefined ? prev.enabled : next.enabled,
    retry: next.retry === undefined ? prev.retry : next.retry,
  };
  const db = await getSql();
  await db.query(
    `insert into qr_reach (id, next_at, intent, set_by, set_at, enabled, retry)
     values (1, $1, $2, $3, $4, $5, $6)
     on conflict (id) do update set
       next_at = excluded.next_at,
       intent = excluded.intent,
       set_by = excluded.set_by,
       set_at = excluded.set_at,
       enabled = excluded.enabled,
       retry = excluded.retry`,
    [row.nextAt, row.intent, row.setBy, row.setAt, row.enabled, row.retry],
  );
  return row;
}

export type ReachPlan = { id: number; at: number; intent: string; setBy: string; setAt: number };

/** Pending plans to reach out, soonest first. */
export async function listReachPlans(): Promise<ReachPlan[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, at, intent, set_by, set_at from qr_reach_plans where done_at is null order by at asc, id asc`,
  );
  return rows.map((row) => ({
    id: asInt(row.id),
    at: asInt(row.at),
    intent: String(row.intent ?? ""),
    setBy: String(row.set_by ?? ""),
    setAt: asInt(row.set_at),
  }));
}

export async function addReachPlan(plan: { at: number; intent: string; setBy: string; setAt: number }): Promise<void> {
  const db = await getSql();
  await db.query(`insert into qr_reach_plans (at, intent, set_by, set_at) values ($1, $2, $3, $4)`, [
    Math.round(plan.at),
    plan.intent.slice(0, 500),
    plan.setBy,
    plan.setAt,
  ]);
}

/** Drop the pending plans written by these authors and put the new list in their place. */
export async function replaceReachPlans(
  setBy: string[],
  plans: Array<{ at: number; intent: string }>,
  author: string,
  setAt: number,
): Promise<void> {
  const db = await getSql();
  await db.query(`delete from qr_reach_plans where done_at is null and set_by = any($1::text[])`, [setBy]);
  for (const plan of plans) await addReachPlan({ ...plan, setBy: author, setAt });
}

export async function finishReachPlans(ids: number[], at: number): Promise<void> {
  if (!ids.length) return;
  const db = await getSql();
  await db.query(`update qr_reach_plans set done_at = $2 where id = any($1::bigint[])`, [ids, at]);
}

export async function delayReachPlans(ids: number[], to: number): Promise<void> {
  if (!ids.length) return;
  const db = await getSql();
  await db.query(`update qr_reach_plans set at = $2 where id = any($1::bigint[])`, [ids, Math.round(to)]);
}

export async function removeReachPlan(id: number): Promise<void> {
  const db = await getSql();
  await db.query(`delete from qr_reach_plans where id = $1 and done_at is null`, [id]);
}

export async function clearReachPlans(): Promise<void> {
  const db = await getSql();
  await db.query(`delete from qr_reach_plans where done_at is null`);
}

export async function insertReachLog(entry: {
  at: number;
  trigger: string;
  intent?: string | null;
  calledLlm: boolean;
  sent: boolean;
  messageId?: string | null;
  text?: string | null;
  pushResult?: string | null;
  nextAt?: number | null;
  nextIntent?: string | null;
  model?: string | null;
  ms?: number | null;
}): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into qr_reach_log
      (at, trigger, intent, called_llm, sent, message_id, text, push_result, next_at, next_intent, model, ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      entry.at,
      entry.trigger,
      entry.intent ?? null,
      entry.calledLlm,
      entry.sent,
      entry.messageId ?? null,
      entry.text ?? null,
      entry.pushResult ?? null,
      entry.nextAt ?? null,
      entry.nextIntent ?? null,
      entry.model ?? null,
      entry.ms ?? null,
    ],
  );
}

export async function listReachLog(limit = 30): Promise<Array<Record<string, unknown>>> {
  const db = await getSql();
  return db.query(
    `select id, at, trigger, intent, called_llm, sent, message_id, text, push_result, next_at, next_intent, model, ms
     from qr_reach_log order by id desc limit $1`,
    [limit],
  );
}

export async function reachCountsToday(timeZone: string, at = now()): Promise<{ llm: number; sent: number; day: string }> {
  const day = localDay(at, timeZone);
  const db = await getSql();
  const rows = await db.query<{ llm: number; sent: number }>(
    `select
       count(*) filter (where called_llm)::int as llm,
       count(*) filter (where sent)::int as sent
     from qr_reach_log
     where at >= $1`,
    [zonedWallMs(day, 4, 0, timeZone)],
  );
  return { llm: asInt(rows[0]?.llm), sent: asInt(rows[0]?.sent), day };
}

export async function silenceSnapshot(_at = now()): Promise<{
  lastUserAt: number | null;
  unanswered: number;
  lines: string[];
}> {
  const db = await getSql();
  const users = await db.query<{ created_at: number }>(
    `select created_at from qingran_messages
     where role = 'user' and forgotten_at is null
       and created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
     order by created_at desc limit 1`,
  );
  const lastUserAt = users[0] ? asInt(users[0].created_at) : null;
  const after = lastUserAt ?? 0;
  const sent = await db.query<{ body: string; created_at: number }>(
    `select body, created_at from qingran_messages
     where role = 'assistant' and kind = 'proactive' and forgotten_at is null and created_at > $1
     order by created_at asc`,
    [after],
  );
  return {
    lastUserAt,
    unanswered: sent.length,
    lines: sent.map((row) => String(row.body ?? "")),
  };
}

export async function insertManualEdit(target: string, before: unknown, after: unknown, at = now()): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into qr_manual_edits (at, target, before, after) values ($1,$2,$3::jsonb,$4::jsonb)`,
    [at, target.slice(0, 80), JSON.stringify(before ?? null), JSON.stringify(after ?? null)],
  );
}

export async function listManualEdits(limit = 30): Promise<Array<Record<string, unknown>>> {
  const db = await getSql();
  return db.query(
    `select id, at, target, before, after from qr_manual_edits order by id desc limit $1`,
    [limit],
  );
}

export async function upsertPushDevice(token: string, env: string): Promise<void> {
  const clean = token.trim().toLowerCase();
  if (!/^[0-9a-f]{32,200}$/.test(clean)) throw new Error("bad-token");
  const where = env === "production" ? "production" : "sandbox";
  const db = await getSql();
  await db.query(
    `insert into qr_push_devices (token, env, created_at) values ($1,$2,$3)
     on conflict (token) do update set env = excluded.env`,
    [clean, where, now()],
  );
}

export async function listPushDevices(): Promise<Array<{ token: string; env: string }>> {
  const db = await getSql();
  const rows = await db.query<{ token: string; env: string }>(
    `select token, env from qr_push_devices`,
  );
  return rows.map((row) => ({ token: String(row.token), env: String(row.env) }));
}

export async function dropPushDevice(token: string): Promise<void> {
  const db = await getSql();
  await db.query(`delete from qr_push_devices where token = $1`, [token]);
}

export async function markPushDevice(token: string, error: string | null): Promise<void> {
  const db = await getSql();
  if (error) {
    await db.query(`update qr_push_devices set last_error = $2 where token = $1`, [token, error.slice(0, 300)]);
  } else {
    await db.query(`update qr_push_devices set last_ok_at = $2, last_error = null where token = $1`, [token, now()]);
  }
}

export async function profileClockZone(): Promise<string> {
  return resolveTz((await getMeta()).timeZone);
}

export type ManualInnerPatch = {
  desire?: string;
  readHer?: string;
  feel?: string;
  now?: string;
  choice?: string;
  plans?: InnerPlan[];
  longings?: LongingItem[];
};

export function innerSnapshot(inner: InnerState): Record<string, unknown> {
  return {
    desire: inner.desire,
    readHer: inner.readHer,
    feel: inner.feel,
    now: inner.now,
    choice: inner.choice,
    plans: inner.plans,
    longings: inner.longings,
    glow: inner.glow,
  };
}

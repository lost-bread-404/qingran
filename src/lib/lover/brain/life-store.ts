import { createHash } from "node:crypto";
import { getSql } from "../../db.ts";
import { newId } from "../storage.ts";
import { now } from "./clock.ts";
import type { InnerPlan, InnerState, LongingItem } from "./types.ts";
import { calendarDay, localDay } from "./time.ts";
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

export function identityHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

export type BusyRow = {
  id: string;
  fromDay: string;
  toDay: string;
  busy: number;
  label: string;
  reason: string;
  identityHash: string;
  createdAt: number;
};

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

export async function writeRhythm(rhythm: string): Promise<void> {
  const text = rhythm.trim().slice(0, 500);
  const db = await getSql();
  await db.query(
    `insert into qingran_profile (id, data, rhythm, updated_at)
     values (1, jsonb_build_object('rhythm', $1::text), $1, now())
     on conflict (id) do update set
       data = coalesce(qingran_profile.data, '{}'::jsonb) || jsonb_build_object('rhythm', $1::text),
       rhythm = excluded.rhythm,
       updated_at = now()`,
    [text],
  );
}

export async function listBusyPeriods(): Promise<BusyRow[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, from_day, to_day, busy, label, reason, identity_hash, created_at
     from qr_busy_periods order by from_day asc, id asc`,
  );
  return rows.map((row) => ({
    id: String(row.id),
    fromDay: String(row.from_day),
    toDay: String(row.to_day),
    busy: Number(row.busy) || 0,
    label: String(row.label ?? ""),
    reason: String(row.reason ?? ""),
    identityHash: String(row.identity_hash ?? ""),
    createdAt: asInt(row.created_at),
  }));
}

export async function replaceBusyPeriods(
  periods: Array<Omit<BusyRow, "createdAt" | "identityHash"> & { identityHash?: string }>,
  hash: string,
  at = now(),
): Promise<void> {
  const db = await getSql();
  await db.query(`delete from qr_busy_periods`);
  for (const row of periods) {
    await db.query(
      `insert into qr_busy_periods (id, from_day, to_day, busy, label, reason, identity_hash, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.id || newId(),
        row.fromDay,
        row.toDay,
        Math.max(0, Math.min(1, Number(row.busy) || 0)),
        row.label.slice(0, 80),
        row.reason.slice(0, 400),
        hash,
        at,
      ],
    );
  }
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

export async function insertGlowEvent(entry: {
  at: number;
  delta: number;
  why: string;
  source: string;
  turnSeq?: number | null;
  glowAfter: number;
}): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into qr_glow_events (at, delta, why, source, turn_seq, glow_after) values ($1,$2,$3,$4,$5,$6)`,
    [entry.at, entry.delta, entry.why.slice(0, 400), entry.source, entry.turnSeq ?? null, entry.glowAfter],
  );
}

export async function listGlowEvents(limit = 60): Promise<Array<{
  id: number;
  at: number;
  delta: number;
  why: string;
  source: string;
  glowAfter: number;
}>> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, at, delta, why, source, glow_after from qr_glow_events order by id desc limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: asInt(row.id),
    at: asInt(row.at),
    delta: Number(row.delta) || 0,
    why: String(row.why ?? ""),
    source: String(row.source ?? ""),
    glowAfter: Number(row.glow_after) || 0,
  }));
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

export async function lastVisibleMessageAt(): Promise<number | null> {
  const db = await getSql();
  const rows = await db.query<{ created_at: number }>(
    `select created_at from qingran_messages
     where created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
       and forgotten_at is null
       and kind is distinct from 'system_notice'
       and kind is distinct from 'proactive'
     order by created_at desc limit 1`,
  );
  return rows[0] ? asInt(rows[0].created_at) : null;
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

export async function countProactiveBetween(fromMs: number, toMs: number): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from qingran_messages
     where kind = 'proactive' and created_at >= $1 and created_at <= $2`,
    [fromMs, toMs],
  );
  return asInt(rows[0]?.n);
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

export async function todayCalendar(at = now()): Promise<string> {
  return calendarDay(at, await profileClockZone());
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

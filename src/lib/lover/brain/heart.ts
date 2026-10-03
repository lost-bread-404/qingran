import { sql } from "./store.ts";
import { formatClock, shiftDay, zonedParts } from "./time.ts";
import { zonedWallMs } from "./spend/policy.ts";
import { clockOf } from "./time.ts";

/**
 * What 清然 keeps between turns besides the memory (docs/brain.md v6):
 * - for proactive messages, which silence he last thought about and how far into it;
 * - one timeline per day (qr_days), written by the night pass, for the monthly report.
 */

export type Inner = { silenceSeen: number; reachStage: number };

export async function getInner(): Promise<Inner> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select silence_seen, reach_stage from qr_inner where id = 1`,
  );
  const row = rows[0] ?? {};
  return {
    silenceSeen: Number(row.silence_seen ?? 0) || 0,
    reachStage: Number(row.reach_stage ?? 0) || 0,
  };
}

export async function setReachStage(silenceSeen: number, stage: number): Promise<void> {
  const db = await sql();
  await db.query(`update qr_inner set silence_seen = $1, reach_stage = $2 where id = 1`, [silenceSeen, stage]);
}

// ---------- time ----------

export function formatLocal(ms: number, timeZone: string, seconds = false): string {
  const p = zonedParts(ms, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
  if (!seconds) return base;
  return `${base}:${pad(Math.floor((ms % 60_000) / 1000))}`;
}

/** "YYYY-MM-DD HH:MM" in her zone → ms. Also accepts ms numbers. Anything else → null. */
export function parseLocalTime(value: unknown, timeZone: string): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const day = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  const ms = zonedWallMs(day, Number(m[4]), Number(m[5]), timeZone);
  return Number.isFinite(ms) ? ms + (m[6] ? Number(m[6]) * 1000 : 0) : null;
}

/** "HH:MM" on a given local day → ms (a time before 04:00 belongs to the next calendar day). */
export function dayClockMs(day: string, clock: string, timeZone: string): number | null {
  const m = clock.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const date = hour < 4 ? shiftDay(day, 1) : day;
  const ms = zonedWallMs(date, hour, minute, timeZone);
  return Number.isFinite(ms) ? ms : null;
}

/** A day runs 04:00–04:00 local. */
export function dayWindow(day: string, timeZone: string): { from: number; to: number } {
  return { from: zonedWallMs(day, 4, 0, timeZone), to: zonedWallMs(shiftDay(day, 1), 4, 0, timeZone) };
}

function gap(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} 分钟`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
  return `${Math.round(m / 1440)} 天`;
}

export async function lastUserAt(before = Number.MAX_SAFE_INTEGER): Promise<number | null> {
  const db = await sql();
  const rows = await db.query<{ at: number | null }>(
    `select max(created_at)::float8 as at from qingran_messages
     where role = 'user' and kind is distinct from 'system_notice' and created_at < $1`,
    [before],
  );
  const at = Number(rows[0]?.at ?? 0);
  return at > 0 ? at : null;
}

/** Plain facts a person would just know: the time, and how long she has been quiet. */
/** 「现在是{clock}」: the time (a full sentence), then when she last spoke. */
export type TimeFacts = {
  /** Date, weekday, time of day. */
  clock: string;
  /** When she last spoke ("" when not asked for, or never). */
  lastSaid: string;
  sinceLast: string;
};

/** The time facts the reply's template lays out (指令 → 每轮回复: {clock} {last_said} {since_last}). */
export async function timeFacts(
  nowMs: number,
  timeZone: string,
  excludeAfter?: number,
  opts: { sinceLast?: boolean } = {},
): Promise<TimeFacts> {
  const facts: TimeFacts = { clock: formatClock(nowMs, timeZone), lastSaid: "", sinceLast: "" };
  if (opts.sinceLast !== false) {
    const last = await lastUserAt(excludeAfter ?? nowMs - 5_000);
    if (last) {
      facts.lastSaid = clockOf(last, timeZone);
      facts.sinceLast = gap(nowMs - last);
    }
  }
  return facts;
}

// ---------- days ----------

/** A later part of a day that was folded in earlier: its timeline goes after what is there. */
export async function appendDayTimeline(day: string, timeline: string, at: number): Promise<void> {
  if (!timeline.trim()) return;
  const db = await sql();
  await db.query(
    `insert into qr_days (day, timeline, updated_at) values ($1, $2, $3)
     on conflict (day) do update
       set timeline = left(case when qr_days.timeline = '' then excluded.timeline
                                else qr_days.timeline || E'\n' || excluded.timeline end, 6000),
           updated_at = excluded.updated_at`,
    [day, timeline.slice(0, 3000), at],
  );
}

export async function saveDayTimeline(day: string, timeline: string, at: number): Promise<void> {
  const db = await sql();
  await db.query(
    `insert into qr_days (day, timeline, updated_at) values ($1, $2, $3)
     on conflict (day) do update set timeline = excluded.timeline, updated_at = excluded.updated_at`,
    [day, timeline.slice(0, 3000), at],
  );
}

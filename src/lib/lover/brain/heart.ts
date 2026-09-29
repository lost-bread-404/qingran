import { sql } from "./store.ts";
import { formatClock, localDay, shiftDay, zonedParts } from "./time.ts";
import { zonedWallMs } from "./spend/policy.ts";
import { clockOf } from "./time.ts";

/**
 * Brain v5 state, all free text (docs/day-example.md):
 * - plans: the list, in order, of what he means to get done — her day, and what he himself wants of her.
 *   A thought of his becomes an item here or is not kept. A time is optional (qr_reach_plans, at may be null).
 *   The first item that is due (no time, or its time has come) is what the reply works on now; once done, the mind takes it off.
 * - thought: what he last thought (qr_inner.now_text), for the record and the settings page only; no model reads it.
 * - days: one text per day (qr_days). Today's is rewritten by the mind each time she goes quiet
 *   (her day, what he said or made up about himself, what is still owed); the night pass turns it into the day's timeline.
 * The memory document lives in qr_dossier.
 */

export type Plan = { id: number; at: number | null; text: string; setBy: string; setAt: number };

export type Inner = { thought: string; updatedAt: number; turnSeq: number; silenceSeen: number };

/** Silence this long (after her last message) gets one thought. */
export const SILENCE_THINK_MS = 45 * 60_000;
/** She counts as "in the chat" if her last message is this recent. Due plans then go into the reply, not a push. */
export const ACTIVE_MS = 10 * 60_000;
const MAX_PLANS = 12;

export async function getInner(): Promise<Inner> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select now_text, updated_at, turn_seq, silence_seen from qr_inner where id = 1`,
  );
  const row = rows[0] ?? {};
  return {
    thought: String(row.now_text ?? ""),
    updatedAt: Number(row.updated_at ?? 0) || 0,
    turnSeq: Number(row.turn_seq ?? 0) || 0,
    silenceSeen: Number(row.silence_seen ?? 0) || 0,
  };
}

export async function setThought(text: string, at: number, turnSeq?: number): Promise<void> {
  const db = await sql();
  await db.query(
    `update qr_inner set now_text = $1, updated_at = $2, turn_seq = greatest(turn_seq, $3) where id = 1`,
    [text.slice(0, 3000), at, turnSeq ?? 0],
  );
}

/** What the reply works on now: the first item in the list whose time has come (no time = now). */
export function currentPlan(plans: Plan[], nowMs: number): Plan | null {
  return plans.find((p) => p.at == null || p.at <= nowMs) ?? null;
}

export async function markSilenceSeen(lastUserAt: number): Promise<void> {
  const db = await sql();
  await db.query(`update qr_inner set silence_seen = $1 where id = 1`, [lastUserAt]);
}

function planOf(row: Record<string, unknown>): Plan {
  return {
    id: Number(row.id),
    at: row.at == null ? null : Number(row.at),
    text: String(row.intent ?? ""),
    setBy: String(row.set_by ?? ""),
    setAt: Number(row.set_at ?? 0) || 0,
  };
}

/** Pending plans in the order the mind wrote them. */
export async function listPlans(): Promise<Plan[]> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, at::float8 as at, intent, set_by, set_at::float8 as set_at
     from qr_reach_plans where done_at is null
     order by id asc`,
  );
  return rows.map(planOf);
}

export async function addPlan(plan: { at: number | null; text: string; setBy: string; setAt: number }): Promise<void> {
  const db = await sql();
  await db.query(`insert into qr_reach_plans (at, intent, set_by, set_at) values ($1, $2, $3, $4)`, [
    plan.at == null ? null : Math.round(plan.at),
    plan.text.slice(0, 500),
    plan.setBy,
    plan.setAt,
  ]);
}

/** The mind rewrites its own plans as one list. Plans Rosie added by hand stay unless she removes them. */
export async function replaceMindPlans(plans: Array<{ at: number | null; text: string }>, setAt: number, setBy = "reflect"): Promise<void> {
  const db = await sql();
  await db.query(`delete from qr_reach_plans where done_at is null and set_by <> 'rosie'`);
  for (const plan of plans.slice(0, MAX_PLANS)) {
    if (!plan.text.trim()) continue;
    await addPlan({ at: plan.at, text: plan.text.trim(), setBy, setAt });
  }
}

export async function removePlan(id: number): Promise<void> {
  const db = await sql();
  await db.query(`delete from qr_reach_plans where id = $1 and done_at is null`, [id]);
}

/** Clearing the chat drops what he meant to do next; plans with a time (dinner, bedtime) stay. */
export async function dropUntimedPlans(): Promise<void> {
  const db = await sql();
  await db.query(`delete from qr_reach_plans where done_at is null and at is null and set_by <> 'rosie'`);
}

// ---------- time ----------

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

export function formatLocal(ms: number, timeZone: string, seconds = false): string {
  const p = zonedParts(ms, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
  if (!seconds) return base;
  return `${base}:${pad(Math.floor((ms % 60_000) / 1000))}`;
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

/** Plain facts a person would just know: the time, how long she has been quiet, when she was around today. */
export async function timeFacts(nowMs: number, timeZone: string, excludeAfter?: number): Promise<string> {
  const last = await lastUserAt(excludeAfter ?? nowMs - 5_000);
  const lines = [formatClock(nowMs, timeZone)];
  if (last) lines.push(`你上一次说话是 ${clockOf(last, timeZone)}，距现在 ${gap(nowMs - last)}。`);
  return lines.join("\n");
}

// ---------- days ----------

export async function recentDays(limit = 7, beforeDay?: string): Promise<Array<{ day: string; timeline: string }>> {
  const db = await sql();
  const rows = await db.query<{ day: string; timeline: string }>(
    `select day, timeline from qr_days where ($2::text is null or day < $2) order by day desc limit $1`,
    [limit, beforeDay ?? null],
  );
  return rows.reverse().map((r) => ({ day: String(r.day), timeline: String(r.timeline ?? "") }));
}

export async function saveDayTimeline(day: string, timeline: string, at: number): Promise<void> {
  const db = await sql();
  await db.query(
    `insert into qr_days (day, timeline, updated_at) values ($1, $2, $3)
     on conflict (day) do update set timeline = excluded.timeline, updated_at = excluded.updated_at`,
    [day, timeline.slice(0, 3000), at],
  );
}

/** A timeline written after `closedAt` means the night pass already ran for this day (a daytime 整理今天 does not count). */
export async function hasDay(day: string, closedAt = 0): Promise<boolean> {
  const db = await sql();
  const rows = await db.query<{ n: number }>(`select count(*)::int as n from qr_days where day = $1 and updated_at >= $2`, [day, closedAt]);
  return Number(rows[0]?.n ?? 0) > 0;
}

// ---------- text for the models ----------

/** Takes off the marks plansText puts around an item, when a model copies them back into the text. */
export function stripPlanMarks(text: string): string {
  return text
    .trim()
    .replace(/^-\s*/, "")
    .replace(/^(（(现在在做|到时间了|\d{4}-\d{2}-\d{2} \d{1,2}:\d{2})）\s*)+/, "")
    .replace(/（[我你]定的）$/, "")
    .trim();
}

export function plansText(plans: Plan[], nowMs: number, timeZone: string): string {
  if (!plans.length) return "";
  const current = currentPlan(plans, nowMs);
  return plans
    .map((p) => {
      const when = p === current ? "（现在在做）" : p.at == null ? "" : p.at <= nowMs ? "（到时间了）" : `（${formatLocal(p.at, timeZone)}）`;
      const who = p.setBy === "rosie" ? "（你定的）" : "";
      return `- ${when}${p.text}${who}`;
    })
    .join("\n");
}

/** Today's running text (the day runs 04:00–04:00). */
export async function todayText(nowMs: number, timeZone: string): Promise<string> {
  const db = await sql();
  const rows = await db.query<{ timeline: string }>(`select timeline from qr_days where day = $1`, [localDay(nowMs, timeZone)]);
  return String(rows[0]?.timeline ?? "").trim();
}

export function daysText(days: Array<{ day: string; timeline: string }>): string {
  return days.filter((d) => d.timeline.trim()).map((d) => `${d.day}：${d.timeline.trim()}`).join("\n");
}

/** What the reply is given of his mind: only the one thing from his list it works on now ("" = nothing). */
export async function mindForReply(nowMs: number): Promise<string> {
  return currentPlan(await listPlans(), nowMs)?.text.trim() ?? "";
}

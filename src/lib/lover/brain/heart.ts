import { sql } from "./store.ts";
import { formatClock, localDay, shiftDay, zonedParts } from "./time.ts";
import { zonedWallMs } from "./spend/policy.ts";
import { clockOf, dayNotes } from "./day-notes.ts";

/**
 * Brain v5 state, all free text:
 * - heart: what he feels and how he reads her right now (qr_inner.now_text)
 * - plans: what he means to do; a time is optional (qr_reach_plans, at may be null)
 * - today: his running notes on her day (qr_day_notes)
 * - days: one timeline per past day, written at night (qr_days)
 * The memory document lives in qr_dossier.
 */

export type Plan = { id: number; at: number | null; text: string; setBy: string; setAt: number };

export type Heart = { text: string; updatedAt: number; turnSeq: number; silenceSeen: number };

/** Silence this long (after her last message) gets one thought. */
export const SILENCE_THINK_MS = 45 * 60_000;
/** She counts as "in the chat" if her last message is this recent. Due plans then go into the reply, not a push. */
export const ACTIVE_MS = 10 * 60_000;
const MAX_PLANS = 12;

export async function getHeart(): Promise<Heart> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select now_text, updated_at, turn_seq, silence_seen from qr_inner where id = 1`,
  );
  const row = rows[0] ?? {};
  return {
    text: String(row.now_text ?? ""),
    updatedAt: Number(row.updated_at ?? 0) || 0,
    turnSeq: Number(row.turn_seq ?? 0) || 0,
    silenceSeen: Number(row.silence_seen ?? 0) || 0,
  };
}

export async function setHeart(text: string, at: number, turnSeq?: number): Promise<void> {
  const db = await sql();
  await db.query(
    `update qr_inner set now_text = $1, updated_at = $2, turn_seq = greatest(turn_seq, $3) where id = 1`,
    [text.slice(0, 3000), at, turnSeq ?? 0],
  );
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

/** Pending plans: untimed first (they are "next"), then by time. */
export async function listPlans(): Promise<Plan[]> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, at::float8 as at, intent, set_by, set_at::float8 as set_at
     from qr_reach_plans where done_at is null
     order by at asc nulls first, id asc`,
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

export async function finishPlans(ids: number[], at: number): Promise<void> {
  if (!ids.length) return;
  const db = await sql();
  await db.query(`update qr_reach_plans set done_at = $2 where id = any($1::bigint[])`, [ids, at]);
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

/** When she was talking to him today, as spans split by 20-minute gaps. */
export async function todaySpans(nowMs: number, timeZone: string): Promise<string> {
  const { from } = dayWindow(localDay(nowMs, timeZone), timeZone);
  const db = await sql();
  const rows = await db.query<{ at: number }>(
    `select created_at::float8 as at from qingran_messages
     where role = 'user' and kind is distinct from 'system_notice' and created_at >= $1 and created_at <= $2
     order by created_at asc`,
    [from, nowMs],
  );
  const spans: Array<[number, number]> = [];
  for (const row of rows) {
    const at = Number(row.at);
    const last = spans[spans.length - 1];
    if (last && at - last[1] <= 20 * 60_000) last[1] = at;
    else spans.push([at, at]);
  }
  if (!spans.length) return "今天她还没来找过你。";
  return `今天她来找你的时段：${spans.map(([a, b]) => (a === b ? clockOf(a, timeZone) : `${clockOf(a, timeZone)}–${clockOf(b, timeZone)}`)).join("、")}`;
}

/** Plain facts a person would just know: the time, how long she has been quiet, when she was around today. */
export async function timeFacts(nowMs: number, timeZone: string, excludeAfter?: number): Promise<string> {
  const [last, spans] = await Promise.all([lastUserAt(excludeAfter ?? nowMs - 5_000), todaySpans(nowMs, timeZone)]);
  const lines = [formatClock(nowMs, timeZone)];
  if (last) lines.push(`她上一次说话是 ${clockOf(last, timeZone)}，距现在 ${gap(nowMs - last)}。`);
  lines.push(spans);
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

export function plansText(plans: Plan[], nowMs: number, timeZone: string, opts: { onlyVisible?: boolean } = {}): string {
  const rows = opts.onlyVisible ? plans.filter((p) => p.at == null || p.at <= nowMs) : plans;
  if (!rows.length) return "";
  return rows
    .map((p) => {
      const when = p.at == null ? "" : p.at <= nowMs ? "（到时间了）" : `（${formatLocal(p.at, timeZone)}）`;
      const who = p.setBy === "rosie" ? "（她定的）" : "";
      return `- ${when}${p.text}${who}`;
    })
    .join("\n");
}

export async function todayNotesText(nowMs: number, timeZone: string): Promise<string> {
  const { from } = dayWindow(localDay(nowMs, timeZone), timeZone);
  const notes = await dayNotes(from, nowMs + 1);
  return notes.map((n) => `${clockOf(n.at, timeZone)} ${n.text}`).join("\n");
}

export function daysText(days: Array<{ day: string; timeline: string }>): string {
  return days.filter((d) => d.timeline.trim()).map((d) => `${d.day}：${d.timeline.trim()}`).join("\n");
}

/** What only he knows, for the reply: his heart, what he means to do now, what he noted about her today. */
export async function mindForReply(nowMs: number, timeZone: string): Promise<string> {
  const [heart, plans, today] = await Promise.all([getHeart(), listPlans(), todayNotesText(nowMs, timeZone)]);
  const parts: string[] = [];
  if (heart.text.trim()) parts.push(`你心里：\n${heart.text.trim()}`);
  const visible = plansText(plans, nowMs, timeZone, { onlyVisible: true });
  if (visible) parts.push(`你打算做的：\n${visible}`);
  if (today.trim()) parts.push(`你记下的她今天：\n${today.trim()}`);
  return parts.join("\n\n");
}

import { sql } from "./store.ts";
import { zonedParts } from "./time.ts";
import { clockOf, dayNotes, todayStart } from "./day-notes.ts";

/**
 * 戏 / 现实: which model + persona answers her NEXT message. reflect decides at the end of each turn,
 * the way a person already knows how they'll greet you when you come back.
 */
/** A mode id from her settings (defaults: "play" 戏, "real" 现实). */
export type TalkMode = string;

export type ModeRow = { at: number; mode: TalkMode; until: number | null; then: TalkMode | null; why: string };

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

function weekdayOf(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(ms));
  } catch {
    return "";
  }
}

/** Before he has decided anything today: weekday daytime is 现实, everything else is 戏 (or her first mode). */
export function defaultMode(ms: number, timeZone: string, ids: string[] = ["play", "real"]): TalkMode {
  const hour = zonedParts(ms, timeZone).hour;
  const want = WEEKDAYS.has(weekdayOf(ms, timeZone)) && hour >= 8 && hour < 20 ? "real" : "play";
  return ids.includes(want) ? want : ids[0] ?? want;
}

function rowOf(raw: Record<string, unknown>): ModeRow {
  return {
    at: Number(raw.at) || 0,
    mode: String(raw.mode ?? "play"),
    until: raw.until_at == null ? null : Number(raw.until_at) || null,
    then: raw.then_mode == null ? null : String(raw.then_mode),
    why: String(raw.why ?? ""),
  };
}

/** The row in force at `at` (plans can hold rows for later times). */
export async function latestMode(at: number = Date.now()): Promise<ModeRow | null> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select at::float8 as at, mode, until_at::float8 as until_at, then_mode, why from qr_mode_log where at <= $1 order by at desc, id desc limit 1`,
    [at],
  );
  return rows[0] ? rowOf(rows[0]) : null;
}

/** What he has already planned for later. */
export async function plannedModes(after: number): Promise<ModeRow[]> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select at::float8 as at, mode, until_at::float8 as until_at, then_mode, why from qr_mode_log where at > $1 order by at asc, id asc limit 10`,
    [after],
  );
  return rows.map(rowOf);
}

/** A plan entry holds until the next one. One older than 16 hours with nothing after it gives way to the clock. Unknown ids too. */
export function modeAt(last: ModeRow | null, at: number, timeZone: string, ids: string[] = ["play", "real"]): TalkMode {
  if (!last || at - last.at > 16 * 3_600_000 || !ids.includes(last.mode)) return defaultMode(at, timeZone, ids);
  return last.mode;
}

export async function effectiveMode(nowMs: number, timeZone: string, ids?: string[]): Promise<TalkMode> {
  return modeAt(await latestMode(nowMs), nowMs, timeZone, ids);
}

async function lastUserMessageAt(before: number): Promise<number | null> {
  const db = await sql();
  const rows = await db.query<{ at: number | null }>(
    `select max(created_at)::float8 as at from qingran_messages where role = 'user' and created_at < $1`,
    [before - 5_000],
  );
  const at = Number(rows[0]?.at ?? 0);
  return at > 0 ? at : null;
}

function gap(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`;
}

/** What a person would just know: how long since she last said anything, what her day has been, how he meant to greet her. */
export async function modeFacts(nowMs: number, timeZone: string, ids?: string[]): Promise<string> {
  const [notes, lastAt, last, later] = await Promise.all([
    dayNotes(todayStart(nowMs, timeZone), nowMs + 1),
    lastUserMessageAt(nowMs),
    latestMode(nowMs),
    plannedModes(nowMs),
  ]);
  const lines: string[] = [];
  if (lastAt) lines.push(`她上一次说话是 ${clockOf(lastAt, timeZone)}，距现在 ${gap(nowMs - lastAt)}。`);
  lines.push(notes.length ? `我记下的她今天：\n${notes.map((n) => `${clockOf(n.at, timeZone)} ${n.text}`).join("\n")}` : "我记下的她今天：（还没有）");
  const current = modeAt(last, nowMs, timeZone, ids);
  const plan: string[] = [];
  if (last && last.mode === current && last.why) plan.push(`现在：${current}（${last.why}）`);
  for (const row of later) plan.push(`${clockOf(row.at, timeZone)} 起：${row.mode}${row.why ? `（${row.why}）` : ""}`);
  if (plan.length) lines.push(`我之前的安排：\n${plan.join("\n")}`);
  return lines.join("\n");
}

/** Replace everything planned after `decidedAt` with a new plan. Entries are hours from now; the first one is what she meets next. */
export async function recordModePlan(
  decidedAt: number,
  entries: Array<{ afterHours: number; mode: TalkMode; why: string }>,
  current: TalkMode,
): Promise<void> {
  const db = await sql();
  await db.query(`delete from qr_mode_log where at > $1`, [decidedAt]);
  const sorted = [...entries].sort((a, b) => a.afterHours - b.afterHours);
  let prev = current;
  for (const entry of sorted) {
    const at = Math.round(decidedAt + Math.max(0, entry.afterHours) * 3_600_000);
    if (entry.mode === prev && at <= decidedAt) continue;
    await db.query(`insert into qr_mode_log (at, mode, why, source) values ($1,$2,$3,'reflect')`, [at, entry.mode, entry.why.slice(0, 300)]);
    prev = entry.mode;
  }
}

export async function recordMode(input: { at: number; mode: TalkMode; until: number | null; then?: TalkMode | null; why: string }): Promise<void> {
  const db = await sql();
  await db.query(`insert into qr_mode_log (at, mode, until_at, then_mode, why, source) values ($1,$2,$3,$4,$5,'reflect')`, [
    input.at,
    input.mode,
    input.until,
    input.then ?? null,
    input.why.slice(0, 500),
  ]);
}

export async function recentModeLog(limit = 20): Promise<ModeRow[]> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select at::float8 as at, mode, until_at::float8 as until_at, then_mode, why from qr_mode_log order by at desc, id desc limit $1`,
    [limit],
  );
  return rows.map(rowOf);
}

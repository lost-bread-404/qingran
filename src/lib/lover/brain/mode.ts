import { sql } from "./store.ts";
import { zonedParts } from "./time.ts";
import { clockOf, dayNotes, todayStart } from "./day-notes.ts";

/**
 * 戏 / 现实: which model + persona answers her NEXT message. reflect decides at the end of each turn,
 * the way a person already knows how they'll greet you when you come back.
 */
export type TalkMode = "play" | "real";

export type ModeRow = { at: number; mode: TalkMode; until: number | null; why: string };

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

function weekdayOf(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(ms));
  } catch {
    return "";
  }
}

/** Before he has decided anything today: weekday daytime is 现实, everything else is 戏. */
export function defaultMode(ms: number, timeZone: string): TalkMode {
  const hour = zonedParts(ms, timeZone).hour;
  return WEEKDAYS.has(weekdayOf(ms, timeZone)) && hour >= 8 && hour < 20 ? "real" : "play";
}

function rowOf(raw: Record<string, unknown>): ModeRow {
  return {
    at: Number(raw.at) || 0,
    mode: raw.mode === "real" ? "real" : "play",
    until: raw.until_at == null ? null : Number(raw.until_at) || null,
    why: String(raw.why ?? ""),
  };
}

export async function latestMode(): Promise<ModeRow | null> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select at::float8 as at, mode, until_at::float8 as until_at, why from qr_mode_log order by at desc, id desc limit 1`,
  );
  return rows[0] ? rowOf(rows[0]) : null;
}

/** A rest with an end time goes back to 现实 when it ends. A decision from an earlier day gives way to the clock. */
export function modeAt(last: ModeRow | null, at: number, timeZone: string): TalkMode {
  if (!last) return defaultMode(at, timeZone);
  if (last.until != null) return at < last.until ? last.mode : "real";
  return todayStart(last.at, timeZone) === todayStart(at, timeZone) ? last.mode : defaultMode(at, timeZone);
}

export async function effectiveMode(nowMs: number, timeZone: string): Promise<TalkMode> {
  return modeAt(await latestMode(), nowMs, timeZone);
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
export async function modeFacts(nowMs: number, timeZone: string): Promise<string> {
  const [notes, lastAt, last] = await Promise.all([
    dayNotes(todayStart(nowMs, timeZone), nowMs + 1),
    lastUserMessageAt(nowMs),
    latestMode(),
  ]);
  const lines: string[] = [];
  if (lastAt) lines.push(`她上一次说话是 ${clockOf(lastAt, timeZone)}，距现在 ${gap(nowMs - lastAt)}。`);
  lines.push(notes.length ? `我记下的她今天：\n${notes.map((n) => `${clockOf(n.at, timeZone)} ${n.text}`).join("\n")}` : "我记下的她今天：（还没有）");
  const current = modeAt(last, nowMs, timeZone);
  if (last && last.mode === current && todayStart(last.at, timeZone) === todayStart(nowMs, timeZone) && last.why) {
    lines.push(`我之前想好的：${last.why}${last.until && last.until > nowMs ? `（休息到 ${clockOf(last.until, timeZone)}）` : ""}`);
  }
  return lines.join("\n");
}

export async function recordMode(input: { at: number; mode: TalkMode; until: number | null; why: string }): Promise<void> {
  const db = await sql();
  await db.query(`insert into qr_mode_log (at, mode, until_at, why, source) values ($1,$2,$3,$4,'reflect')`, [
    input.at,
    input.mode,
    input.until,
    input.why.slice(0, 500),
  ]);
}

export async function recentModeLog(limit = 20): Promise<ModeRow[]> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select at::float8 as at, mode, until_at::float8 as until_at, why from qr_mode_log order by at desc, id desc limit $1`,
    [limit],
  );
  return rows.map(rowOf);
}

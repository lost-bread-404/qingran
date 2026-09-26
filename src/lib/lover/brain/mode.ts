import { sql } from "./store.ts";

/**
 * Which of her modes answers her next message. The mind picks it after each reply and when she goes quiet;
 * the night pass picks the one she meets in the morning. A choice holds until the next one.
 */
/** A mode id from her settings. */
export type TalkMode = string;

export type ModeRow = { at: number; mode: TalkMode; until: number | null; then: TalkMode | null; why: string };

function rowOf(raw: Record<string, unknown>): ModeRow {
  return {
    at: Number(raw.at) || 0,
    mode: String(raw.mode ?? ""),
    until: raw.until_at == null ? null : Number(raw.until_at) || null,
    then: raw.then_mode == null ? null : String(raw.then_mode),
    why: String(raw.why ?? ""),
  };
}

/** The choice in force at `at`. */
export async function latestMode(at: number = Date.now()): Promise<ModeRow | null> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select at::float8 as at, mode, until_at::float8 as until_at, then_mode, why from qr_mode_log where at <= $1 order by at desc, id desc limit 1`,
    [at],
  );
  return rows[0] ? rowOf(rows[0]) : null;
}

/** The last choice holds. Nothing chosen yet, or a mode she has since deleted → her first mode. */
export function modeAt(last: ModeRow | null, ids: string[]): TalkMode {
  if (last && ids.includes(last.mode)) return last.mode;
  return ids[0] ?? "play";
}

export async function effectiveMode(nowMs: number, _timeZone: string, ids: string[] = []): Promise<TalkMode> {
  return modeAt(await latestMode(nowMs), ids);
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


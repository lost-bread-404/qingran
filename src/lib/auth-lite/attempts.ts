import { getSql } from "../db.ts";

export const ATTEMPT_WINDOW_MS = 15 * 60_000;
export const ATTEMPT_MAX_FAILS = 5;

export function clientIp(xff: string | null | undefined): string {
  const first = (xff ?? "").split(",")[0]?.trim();
  return first || "unknown";
}

export type AttemptState = { fails: number; windowStart: number; limited: boolean };

export async function readAttempt(ip: string): Promise<{ fails: number; windowStart: number } | null> {
  const db = await getSql();
  const rows = await db.query<{ fails: number; window_start: number }>(
    "select fails, window_start from auth_attempts where ip = $1",
    [ip],
  );
  const row = rows[0];
  if (!row) return null;
  return { fails: Number(row.fails) || 0, windowStart: Number(row.window_start) || 0 };
}

export async function isLimited(ip: string, nowMs: number): Promise<boolean> {
  const row = await readAttempt(ip);
  if (!row) return false;
  if (nowMs - row.windowStart >= ATTEMPT_WINDOW_MS) return false;
  return row.fails >= ATTEMPT_MAX_FAILS;
}

export async function failAttempt(ip: string, nowMs: number): Promise<AttemptState> {
  const db = await getSql();
  const rows = await db.query<{ fails: number; window_start: number }>(
    `insert into auth_attempts (ip, fails, window_start) values ($1, 1, $2)
     on conflict (ip) do update set
       fails = case when $2 - auth_attempts.window_start >= $3 then 1 else auth_attempts.fails + 1 end,
       window_start = case when $2 - auth_attempts.window_start >= $3 then $2 else auth_attempts.window_start end
     returning fails, window_start`,
    [ip, nowMs, ATTEMPT_WINDOW_MS],
  );
  const fails = Number(rows[0]?.fails) || 1;
  const windowStart = Number(rows[0]?.window_start) || nowMs;
  return { fails, windowStart, limited: fails >= ATTEMPT_MAX_FAILS };
}

export async function resetAttempt(ip: string): Promise<void> {
  const db = await getSql();
  await db.query("delete from auth_attempts where ip = $1", [ip]);
}

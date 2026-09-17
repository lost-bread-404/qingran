export const ATTEMPT_WINDOW_MS = 15 * 60_000;
export const ATTEMPT_MAX_FAILS = 5;

export function clientIp(xff: string | null | undefined): string {
  const first = (xff ?? "").split(",")[0]?.trim();
  return first || "unknown";
}

export type AttemptState = { fails: number; windowStart: number; limited: boolean };

export function nextFailState(
  row: { fails: number; windowStart: number } | null,
  nowMs: number,
): AttemptState {
  let fails = 1;
  let windowStart = nowMs;
  if (row && nowMs - row.windowStart < ATTEMPT_WINDOW_MS) {
    fails = row.fails + 1;
    windowStart = row.windowStart;
  }
  return { fails, windowStart, limited: fails >= ATTEMPT_MAX_FAILS };
}

async function db() {
  const { getSql } = await import("../db.ts");
  return getSql();
}

export async function readAttempt(ip: string): Promise<{ fails: number; windowStart: number } | null> {
  const sql = await db();
  const rows = await sql.query<{ fails: number; window_start: number }>(
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
  const sql = await db();
  const next = nextFailState(await readAttempt(ip), nowMs);
  await sql.query(
    `insert into auth_attempts (ip, fails, window_start)
     values ($1, $2, $3)
     on conflict (ip) do update set fails = excluded.fails, window_start = excluded.window_start`,
    [ip, next.fails, next.windowStart],
  );
  return next;
}

export async function resetAttempt(ip: string): Promise<void> {
  const sql = await db();
  await sql.query("delete from auth_attempts where ip = $1", [ip]);
}

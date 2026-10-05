import { SLEEP_GAP_MS, SLEEP_MARK_HOUR } from "./config.ts";
import { sql } from "./store.ts";
import { isoDate, shiftDay, zonedParts } from "./time.ts";
import { zonedWallMs } from "./spend/policy.ts";

/**
 * v7 (docs/brain.md): her day ends when she falls asleep. Sleep is a silence of SLEEP_GAP_MS or more that runs past
 * SLEEP_MARK_HOUR local (05:00). Her real nights (9/26–10/4) all do; the evening breaks she came back from around
 * midnight (21:25→00:20, 23:40→01:40, 00:27→02:28) do not. The day reply gets everything since the last sleep; the
 * night pass runs on the day before it, once the silence has passed 05:00 and lasted two hours.
 */
export function sleptBetween(before: number, after: number, timeZone: string): boolean {
  if (after - before < SLEEP_GAP_MS) return false;
  const p = zonedParts(before, timeZone);
  const day = isoDate(p.year, p.month, p.day);
  let mark = zonedWallMs(day, SLEEP_MARK_HOUR, 0, timeZone);
  if (mark <= before) mark = zonedWallMs(shiftDay(day, 1), SLEEP_MARK_HOUR, 0, timeZone);
  return mark <= after;
}

/** Times of her and his messages (not cleared, not notices), oldest first. */
export async function messageTimes(from: number, to: number): Promise<number[]> {
  const db = await sql();
  const rows = await db.query<{ t: number | string }>(
    `select created_at::float8 as t from qingran_messages
     where created_at >= $1 and created_at < $2 and forgotten_at is null and kind is distinct from 'system_notice'
     order by created_at asc`,
    [from, to],
  );
  return rows.map((r) => Number(r.t)).filter(Number.isFinite);
}

/**
 * Where her day that `at` belongs to began: the first message after the last sleep before `at` (a message at `at`
 * itself counts as after it). Looks back two days at most; with no sleep in that time, the start of that window.
 */
export async function dayStart(at: number, timeZone: string): Promise<number> {
  const from = at - 2 * 24 * 60 * 60_000;
  const times = await messageTimes(from, at);
  let next = at;
  for (let i = times.length - 1; i >= 0; i -= 1) {
    if (sleptBetween(times[i]!, next, timeZone)) return next;
    next = times[i]!;
  }
  return times.length ? times[0]! : at;
}

/**
 * The last finished day after `after`: the time of its last message before a sleep (the silence until `at` counts
 * when it is long enough). Null when she has not slept since.
 */
export async function lastSleepAfter(after: number, at: number, timeZone: string): Promise<number | null> {
  const times = await messageTimes(Math.max(after + 1, at - 3 * 24 * 60 * 60_000), at);
  for (let i = times.length - 1; i >= 0; i -= 1) {
    const next = i + 1 < times.length ? times[i + 1]! : at;
    if (sleptBetween(times[i]!, next, timeZone)) return times[i]!;
  }
  return null;
}

import { sql } from "./store.ts";
import { zonedParts } from "./time.ts";

/**
 * 清然's running notes about Rosie's day — like a person remembering "she went to study at 9:30,
 * came back at noon exhausted". Plain sentences, no categories. The reply and reflect see today's notes;
 * the monthly report reads them all and works out study time, rest, mood and sleep itself.
 */
export type DayNote = { at: number; text: string };

export async function addDayNote(at: number, text: string): Promise<void> {
  const db = await sql();
  await db.query(`insert into qr_day_notes (at, text) values ($1, $2)`, [at, text.slice(0, 300)]);
}

export async function dayNotes(from: number, to: number): Promise<DayNote[]> {
  const db = await sql();
  const rows = await db.query<{ at: number; text: string }>(
    `select at::float8 as at, text from qr_day_notes where at >= $1 and at < $2 order by at asc, id asc`,
    [from, to],
  );
  return rows.map((r) => ({ at: Number(r.at), text: String(r.text) }));
}

export function clockOf(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** A day runs 04:00–04:00 local, so a 1am bedtime belongs to the evening before. */
export function dayKey(ms: number, timeZone: string): string {
  const p = zonedParts(ms - 4 * 3_600_000, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function todayStart(ms: number, timeZone: string): number {
  const shifted = ms - 4 * 3_600_000;
  const p = zonedParts(shifted, timeZone);
  return shifted - (p.hour * 60 + p.minute) * 60_000 - (shifted % 60_000) + 4 * 3_600_000;
}

export function groupByDay(notes: DayNote[], timeZone: string): Array<{ day: string; lines: string[] }> {
  const map = new Map<string, string[]>();
  for (const n of notes) {
    const key = dayKey(n.at, timeZone);
    const list = map.get(key) ?? [];
    list.push(`${clockOf(n.at, timeZone)} ${n.text}`);
    map.set(key, list);
  }
  return [...map.entries()].map(([day, lines]) => ({ day, lines }));
}

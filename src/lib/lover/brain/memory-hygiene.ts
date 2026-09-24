import { getSql } from "../../db.ts";
import { now } from "./clock.ts";
import { DROP_PORTRAIT_TOPICS } from "./portrait-kind.ts";
import { getMeta, listNotes, patchMeta, resetInnerTurn, bumpNotesVersion, pgTextArray } from "./store.ts";
import type { Note, Subject } from "./types.ts";

export { DROP_PORTRAIT_TOPICS };

export const QINGRAN_SELF_NOTE_DAY = "2026-09-21";

const BEHAVIOR_RE =
  /清然(重复)?承诺|清然答应|清然把她|清然陪|清然安抚|清然主导|清然训|清然哄|我(重复)?承诺|我答应你|我把你|我安抚你|我主导/;
const TIME_RE = /今晚|明天|后天|周[一二三四五六日天]|点前|\d+\s*点|下次/;
const PROMISE_RE = /承诺|答应|会/;

export function isQingranBehaviorRecap(text: string): boolean {
  return BEHAVIOR_RE.test(text);
}

export function isConcreteQingranPromise(text: string): boolean {
  if (/重复承诺/.test(text)) return false;
  const named = /清然/.test(text);
  const first = /我承诺|我答应/.test(text);
  if (!named && !first) return false;
  return TIME_RE.test(text) && PROMISE_RE.test(text) && text.replace(/\s+/g, "").length >= 12;
}

export function keepArchiveNote(opts: {
  text: string;
  subject: Subject;
  fromRosie: boolean;
}): boolean {
  if (isConcreteQingranPromise(opts.text)) return true;
  if (opts.subject === "qingran") return false;
  if (isQingranBehaviorRecap(opts.text) && !opts.fromRosie) return false;
  return true;
}

export function isStorySeedNote(note: { sourceIds?: string[] | null }): boolean {
  return (note.sourceIds ?? []).includes("story");
}

export function isHygieneSelfNote(note: Note): boolean {
  if (note.subject !== "qingran" && note.subject !== "us") return false;
  if (note.fromRosie) return false;
  if (note.localDay && note.localDay < QINGRAN_SELF_NOTE_DAY) return false;
  return isQingranBehaviorRecap(note.text) && !isConcreteQingranPromise(note.text);
}

export async function listQingranSelfNotes(): Promise<Note[]> {
  const rows = await listNotes({ fromDay: QINGRAN_SELF_NOTE_DAY, status: "active", limit: 400 });
  return rows.filter(isHygieneSelfNote);
}

export async function deleteNotesByIds(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const db = await getSql();
  const ts = now();
  const rows = await db.query<{ id: string }>(
    `update mem_notes set status = 'archived', updated_at = $2
     where id = any($1::text[]) and status = 'active'
     returning id`,
    [pgTextArray(ids), ts],
  );
  if (rows.length) await bumpNotesVersion();
  return rows.length;
}

export async function sweepNamedPortraits(): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ id: string }>(
    `delete from qr_portrait where topic = any($1::text[]) returning id`,
    [pgTextArray([...DROP_PORTRAIT_TOPICS])],
  );
  return rows.length;
}

export async function ensureMemoryHygiene(): Promise<void> {
  const meta = await getMeta();
  if (meta.hygieneMemoryLoopAt) return;
  try {
    await resetInnerTurn();
    await patchMeta({ hygieneMemoryLoopAt: now() });
  } catch (err) {
    console.error("[hygiene] failed", err);
  }
}

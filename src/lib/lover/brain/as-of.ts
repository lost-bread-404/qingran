import { getSql } from "../../db.ts";
import { getMessage, getNote } from "./store.ts";
import type { Note, StoredMessage } from "./types.ts";

function asNote(raw: unknown, fallback: Note | null): Note | null {
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  const text = typeof r.text === "string" ? r.text : fallback?.text;
  if (text == null) return fallback;
  const base = fallback;
  return {
    id: String(r.id ?? base?.id ?? ""),
    text,
    tags: Array.isArray(r.tags) ? r.tags.map(String) : (base?.tags ?? []),
    subject: (typeof r.subject === "string" ? r.subject : base?.subject ?? "rosie") as Note["subject"],
    lens: Array.isArray(r.lens) ? (r.lens as Note["lens"]) : (base?.lens ?? []),
    fromRosie: typeof r.fromRosie === "boolean" ? r.fromRosie : (base?.fromRosie ?? true),
    weight: typeof r.weight === "number" ? r.weight : (base?.weight ?? 3),
    status: (typeof r.status === "string" ? r.status : base?.status ?? "active") as Note["status"],
    supersededBy: r.supersededBy == null ? (base?.supersededBy ?? null) : String(r.supersededBy),
    links: Array.isArray(r.links) ? r.links.map(String) : (base?.links ?? []),
    happenedAt: Number(r.happenedAt ?? base?.happenedAt ?? 0),
    localDay: String(r.localDay ?? base?.localDay ?? ""),
    sourceIds: Array.isArray(r.sourceIds) ? r.sourceIds.map(String) : (base?.sourceIds ?? []),
    recallCount: Number(r.recallCount ?? base?.recallCount ?? 0),
    lastRecalledAt: r.lastRecalledAt == null ? (base?.lastRecalledAt ?? null) : Number(r.lastRecalledAt),
    createdAt: Number(r.createdAt ?? base?.createdAt ?? 0),
    updatedAt: Number(r.updatedAt ?? base?.updatedAt ?? 0),
  };
}

export async function noteAsOf(id: string, t: number): Promise<Note | null> {
  const current = await getNote(id);
  const db = await getSql();
  const hist = await db.query<{ after: unknown; at: number }>(
    `select after, at from mem_history
     where table_name = 'mem_notes' and row_id = $1 and at <= $2
     order by at desc, id desc limit 1`,
    [id, t],
  );
  if (hist[0]) {
    const n = asNote(hist[0].after, current);
    if (!n) return null;
    if (n.createdAt && n.createdAt > t) return null;
    return n;
  }
  if (!current) return null;
  if (current.createdAt > t) return null;
  return current;
}

export async function messageAsOf(id: string, t: number): Promise<StoredMessage | null> {
  const current = await getMessage(id);
  if (!current) return null;
  if (current.createdAt > t) return null;
  const db = await getSql();
  const future = await db.query<{ before: string; at: number }>(
    `select before, at from qingran_message_edits
     where message_id = $1 and at > $2
     order by at asc, id asc limit 1`,
    [id, t],
  );
  const text = future[0]?.before ?? current.text;
  return { ...current, text };
}

export async function messageEditedAfter(id: string, t: number): Promise<boolean> {
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from qingran_message_edits where message_id = $1 and at > $2`,
    [id, t],
  );
  return Number(rows[0]?.n) > 0;
}

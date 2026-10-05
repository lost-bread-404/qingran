import { now } from "./clock.ts";
import { localDay } from "./time.ts";
import { sql } from "./store.ts";

/**
 * qr_memories (docs/brain.md v7). Only his ｛｝ notes are still written here (source = inner). The rest is the old
 * memory library (v6 and before): read once by the first v7 night pass, which folds it into the dossier, and kept
 * for export. Nothing recalls from it. Also here: her complaints (qr_feedback) and the night pass's marks.
 */
export type Memory = {
  id: number;
  kind: "moment" | "insight";
  source: "story" | "night" | "rosie" | "inner";
  day: string;
  at: number | null;
  seq: number;
  body: string;
  keys: string;
  thread: string;
  importance: number;
  changed: string;
  recalled: number;
  knows: string;
};

export type NewMemory = {
  kind: "moment" | "insight";
  source: "story" | "night" | "rosie" | "inner";
  day: string;
  at: number | null;
  seq?: number;
  body: string;
  keys?: string;
  thread?: string;
  importance?: number;
  knows?: string;
};

function rowOf(r: Record<string, unknown>): Memory {
  return {
    id: Number(r.id),
    kind: r.kind === "insight" ? "insight" : "moment",
    source: r.source === "story" ? "story" : r.source === "rosie" ? "rosie" : r.source === "inner" ? "inner" : "night",
    day: String(r.day ?? ""),
    at: r.at == null ? null : Number(r.at),
    seq: Number(r.seq ?? 0) || 0,
    body: String(r.body ?? ""),
    keys: String(r.keys ?? ""),
    thread: String(r.thread ?? ""),
    importance: Number(r.importance ?? 5) || 5,
    changed: String(r.changed ?? ""),
    recalled: Number(r.recalled ?? 0) || 0,
    knows: String(r.knows ?? "").trim(),
  };
}

/** Names separated by spaces; 清然 himself and Rosie are never listed (清然 in it means he knows: empty). */
function knowsText(raw: unknown): string {
  const names = String(raw ?? "")
    .split(/[\s,，、]+/)
    .map((n) => n.trim())
    .filter((n) => n && n !== "Rosie");
  return names.includes("清然") ? "" : [...new Set(names)].join(" ").slice(0, 80);
}

function clampImportance(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(1, Math.min(10, v)) : 5;
}

/** All of them, in the order they happened: the story first (by its order), then by time. */
export async function listMemories(): Promise<Memory[]> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, kind, source, day, at::float8 as at, seq, body, keys, thread, importance, changed, recalled, knows
     from qr_memories
     order by (source = 'story') desc, seq asc, coalesce(at, 0) asc, id asc`,
  );
  return rows.map(rowOf);
}

export async function addMemories(rows: NewMemory[]): Promise<void> {
  if (!rows.length) return;
  const db = await sql();
  const at = now();
  for (const m of rows) {
    if (!m.body.trim()) continue;
    await db.query(
      `insert into qr_memories (kind, source, day, at, seq, body, keys, thread, importance, created_at, updated_at, knows)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,
      [
        m.kind,
        m.source,
        m.day,
        m.at == null ? null : Math.round(m.at),
        m.seq ?? 0,
        m.body.trim().slice(0, 4000),
        (m.keys ?? "").trim().slice(0, 500),
        (m.thread ?? "").trim().slice(0, 40),
        clampImportance(m.importance),
        at,
        knowsText(m.knows),
      ],
    );
  }
}

/**
 * Rewrites one memory: her edit, or the night pass merging a day into an event that continued. A new body gets its
 * vector again (embedMissing).
 */
export async function updateMemory(
  id: number,
  patch: { body?: string; changed?: string; keys?: string; thread?: string; importance?: number; day?: string; at?: number; knows?: string },
): Promise<void> {
  const db = await sql();
  const ts = now();
  if (patch.knows != null) {
    await db.query(`update qr_memories set knows = $2, updated_at = $3 where id = $1`, [id, knowsText(patch.knows), ts]);
  }
  if (patch.body != null) {
    await db.query(`update qr_memories set body = $2, updated_at = $3 where id = $1`, [id, patch.body.trim().slice(0, 4000), ts]);
  }
  if (patch.changed != null) {
    await db.query(`update qr_memories set changed = $2, updated_at = $3 where id = $1`, [id, patch.changed.trim().slice(0, 500), ts]);
  }
  if (patch.keys != null || patch.thread != null || patch.importance != null || patch.day != null || patch.at != null) {
    await db.query(
      `update qr_memories set keys = coalesce($2, keys), thread = coalesce($3, thread), importance = coalesce($4, importance),
         day = coalesce($5, day), at = coalesce($6, at), updated_at = $7 where id = $1`,
      [
        id,
        patch.keys?.trim().slice(0, 500) ?? null,
        patch.thread?.trim().slice(0, 80) ?? null,
        patch.importance == null ? null : clampImportance(patch.importance),
        patch.day ?? null,
        patch.at ?? null,
        ts,
      ],
    );
  }
}

/**
 * Rosie's complaints about how 清然 behaved, found by the night pass: kept in the back (qr_feedback) for tuning the
 * app, never shown to him and never recalled — most of them came from prompts that have since been fixed.
 */
export async function addFeedback(rows: Array<{ day: string; at: number; body: string }>, ts = now()): Promise<void> {
  if (!rows.length) return;
  const db = await sql();
  for (const r of rows) {
    await db.query(`insert into qr_feedback (day, at, body, source, created_at) values ($1, $2, $3, 'night', $4)`, [
      r.day,
      r.at,
      r.body.slice(0, 2000),
      ts,
    ]);
  }
}

// ---------- marks ----------

export async function getMark(key: string): Promise<string | null> {
  const db = await sql();
  const rows = await db.query<{ value: string }>(`select value from qr_memory_marks where key = $1`, [key]);
  return rows[0] ? String(rows[0].value ?? "") : null;
}

export async function setMark(key: string, value: string, at = now()): Promise<void> {
  const db = await sql();
  await db.query(
    `insert into qr_memory_marks (key, value, at) values ($1, $2, $3)
     on conflict (key) do update set value = excluded.value, at = excluded.at`,
    [key, value, at],
  );
}

/**
 * His ｛｝ notes: what he has to keep to (a game's answer, his cards, a score, a promise, a detail he made up). Never
 * shown or spoken; he sees today's again every turn (the last few, since she last cleared the chat), and the night
 * pass reads them. What he thinks of her is not kept there: he sees it afresh each turn (10/4).
 */
const INNER_KEEP_MS = 24 * 3_600_000;
const INNER_KEEP = 8;

export async function keepInner(notes: string, atMs: number, timeZone: string): Promise<void> {
  const body = notes.trim();
  if (!body) return;
  await addMemories([{ kind: "moment", source: "inner", day: localDay(atMs, timeZone), at: atMs, body, importance: 3 }]).catch((err) =>
    console.error(err),
  );
}

/** His ｛｝ notes of the last day, oldest first (pack.ts keeps only today's). */
export async function recentInner(nowMs = now()): Promise<Array<{ body: string; at: number }>> {
  const db = await sql();
  const rows = await db.query<{ body: string; at: number | string }>(
    `select body, at from (
       select body, at, id from qr_memories where source = 'inner' and at > $1 and at <= $2
         and at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
       order by at desc, id desc limit ${INNER_KEEP}
     ) t order by at asc, id asc`,
    [nowMs - INNER_KEEP_MS, nowMs],
  );
  return rows.map((r) => ({ body: String(r.body).trim(), at: Number(r.at) || 0 })).filter((r) => r.body);
}

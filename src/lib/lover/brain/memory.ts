import { now } from "./clock.ts";
import { sql } from "./store.ts";
import { backgroundOf, buildIndex, rankDocs, type Background, type SearchIndex } from "./memory-search.ts";
import { isNightNoiseBody, modelFacingText } from "../message-markup.ts";

/**
 * 清然's memory (docs/brain.md v6): moments of the two of them, kept one by one and never rewritten by the night pass.
 * - story: cut from the storyline Rosie wrote (what happened before this app), paragraph by paragraph, her words as written;
 * - night: written each night from that day's talk;
 * - insight: something 清然 came to understand about Rosie, written by the night pass, which may later be corrected.
 * A moment that stopped being true keeps its text and gets a 「后来」 note (changed).
 */
export type Memory = {
  id: number;
  kind: "moment" | "insight";
  source: "story" | "night" | "rosie";
  day: string;
  at: number | null;
  seq: number;
  body: string;
  keys: string;
  thread: string;
  importance: number;
  changed: string;
  recalled: number;
};

export type NewMemory = {
  kind: "moment" | "insight";
  source: "story" | "night" | "rosie";
  day: string;
  at: number | null;
  seq?: number;
  body: string;
  keys?: string;
  thread?: string;
  importance?: number;
};

function rowOf(r: Record<string, unknown>): Memory {
  return {
    id: Number(r.id),
    kind: r.kind === "insight" ? "insight" : "moment",
    source: r.source === "story" ? "story" : r.source === "rosie" ? "rosie" : "night",
    day: String(r.day ?? ""),
    at: r.at == null ? null : Number(r.at),
    seq: Number(r.seq ?? 0) || 0,
    body: String(r.body ?? ""),
    keys: String(r.keys ?? ""),
    thread: String(r.thread ?? ""),
    importance: Number(r.importance ?? 5) || 5,
    changed: String(r.changed ?? ""),
    recalled: Number(r.recalled ?? 0) || 0,
  };
}

function clampImportance(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(1, Math.min(10, v)) : 5;
}

/** All of them, in the order they happened: the story first (by its order), then by time. */
export async function listMemories(): Promise<Memory[]> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, kind, source, day, at::float8 as at, seq, body, keys, thread, importance, changed, recalled
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
      `insert into qr_memories (kind, source, day, at, seq, body, keys, thread, importance, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
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
      ],
    );
  }
  memoryCache = null;
}

export async function updateMemory(id: number, patch: { body?: string; changed?: string }): Promise<void> {
  const db = await sql();
  if (patch.body != null) {
    await db.query(`update qr_memories set body = $2, updated_at = $3 where id = $1`, [id, patch.body.trim().slice(0, 4000), now()]);
  }
  if (patch.changed != null) {
    await db.query(`update qr_memories set changed = $2, updated_at = $3 where id = $1`, [id, patch.changed.trim().slice(0, 500), now()]);
  }
  memoryCache = null;
}

export async function deleteMemory(id: number): Promise<void> {
  const db = await sql();
  await db.query(`delete from qr_memories where id = $1`, [id]);
  memoryCache = null;
}

export async function markRecalled(ids: number[], at = now()): Promise<void> {
  if (!ids.length) return;
  const db = await sql();
  await db.query(`update qr_memories set recalled = recalled + 1, recalled_at = $2 where id = any($1::bigint[])`, [ids, at]);
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

// ---------- the story ----------

function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}

/**
 * The storyline she wrote, cut into moments by paragraph, word for word. A short line that only names someone
 * (「林泽：」) stays with the paragraph after it. Runs whenever the storyline changed; the story's moments are replaced
 * whole (the ones the night pass wrote are not touched).
 */
export function cutStory(text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let carry = "";
  for (const p of paras) {
    if (p.length < 12 && !/[。！？.!?]$/.test(p)) {
      carry = carry ? `${carry}\n${p}` : p;
      continue;
    }
    out.push(carry ? `${carry}\n${p}` : p);
    carry = "";
  }
  if (carry) out.push(carry);
  return out;
}

export async function syncStory(storyline: string): Promise<boolean> {
  const hash = hashText(storyline.trim());
  if ((await getMark("story")) === hash) return false;
  const db = await sql();
  await db.query(`delete from qr_memories where source = 'story'`);
  await addMemories(
    cutStory(storyline).map((body, i) => ({ kind: "moment" as const, source: "story" as const, day: "", at: null, seq: i + 1, body, importance: 7 })),
  );
  await setMark("story", hash);
  return true;
}

// ---------- recalling ----------

/** Their recent talk, for how common a word is between them (see memory-search.ts). Refreshed every few hours. */
const BACKGROUND_MESSAGES = 1500;
const BACKGROUND_TTL_MS = 6 * 3600_000;
let backgroundCache: { at: number; value: Background } | null = null;
let memoryCache: { key: string; memories: Memory[]; index: SearchIndex } | null = null;

async function background(): Promise<Background> {
  if (backgroundCache && Date.now() - backgroundCache.at < BACKGROUND_TTL_MS) return backgroundCache.value;
  const db = await sql();
  const rows = await db.query<{ body: string }>(
    `select body from qingran_messages where kind is distinct from 'system_notice' order by created_at desc limit $1`,
    [BACKGROUND_MESSAGES],
  );
  const value = backgroundOf(rows.map((r) => String(r.body ?? "")).filter((b) => !isNightNoiseBody(b)).map(modelFacingText));
  backgroundCache = { at: Date.now(), value };
  return value;
}

async function memoryIndex(): Promise<{ memories: Memory[]; index: SearchIndex }> {
  const bg = await background();
  const db = await sql();
  const stamp = await db.query<{ n: number; t: number }>(`select count(*)::int as n, coalesce(max(updated_at), 0)::float8 as t from qr_memories`);
  const key = `${stamp[0]?.n ?? 0}:${stamp[0]?.t ?? 0}:${backgroundCache?.at ?? 0}`;
  if (memoryCache && memoryCache.key === key) return memoryCache;
  const memories = await listMemories();
  const index = buildIndex(
    memories.map((m) => ({ id: m.id, text: m.body, keys: `${m.keys} ${m.thread}`, importance: m.importance, at: m.at, recalled: m.recalled })),
    bg,
  );
  memoryCache = { key, memories, index };
  return memoryCache;
}

/** How many come back at once, and how well a moment has to fit to come back at all. */
const RECALL_TOP = 4;
const RECALL_WITH_THREAD = 2;
const RECALL_MIN_FIT = 12;
const RECALL_KEEP_SHARE = 0.5;

export type Recall = { memories: Memory[]; scores: Array<{ id: number; score: number }> };

/**
 * What comes back to him now: the few moments that fit best, plus, for the best ones, the moment just before on the
 * same line (what led up to it), shown in the order they happened.
 */
export async function recall(
  query: string,
  nowMs = now(),
  opts: { top?: number; minFit?: number; keepShare?: number; withThread?: number } = {},
): Promise<Recall> {
  if (!query.trim()) return { memories: [], scores: [] };
  const { memories, index } = await memoryIndex();
  if (!memories.length) return { memories: [], scores: [] };
  const ranked = rankDocs(index, query, nowMs, opts.minFit ?? RECALL_MIN_FIT);
  const top = ranked[0];
  if (!top) return { memories: [], scores: [] };
  const share = opts.keepShare ?? RECALL_KEEP_SHARE;
  const picked = ranked.filter((h) => h.fit >= top.fit * share).slice(0, opts.top ?? RECALL_TOP);
  const byId = new Map(memories.map((m) => [m.id, m]));
  const order = new Map(memories.map((m, i) => [m.id, i]));
  const chosen = new Set(picked.map((h) => h.id));
  let extra = 0;
  for (const hit of picked) {
    if (extra >= (opts.withThread ?? RECALL_WITH_THREAD)) break;
    const m = byId.get(hit.id);
    if (!m?.thread) continue;
    const i = order.get(m.id)!;
    const before = [...memories.slice(0, i)].reverse().find((x) => x.thread === m.thread);
    if (before && !chosen.has(before.id)) {
      chosen.add(before.id);
      extra += 1;
    }
  }
  return {
    memories: memories.filter((m) => chosen.has(m.id)),
    scores: picked.map((h) => ({ id: h.id, score: Math.round(h.score * 10) / 10 })),
  };
}

function dayLabel(day: string): string {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[2])}月${Number(m[3])}日` : day;
}

/** The recalled moments as he is given them. */
export function recallText(memories: Memory[]): string {
  return memories
    .map((m) => {
      const when = m.source === "story" ? "以前" : dayLabel(m.day) || "以前";
      const what = m.kind === "insight" ? `（${when}，清然看懂的）` : `（${when}）`;
      const later = m.changed.trim() ? `（后来：${m.changed.trim()}）` : "";
      return `${what}${m.body.trim()}${later}`;
    })
    .join("\n");
}

/** Recent memories with ids, for the night pass to see what it might have to mark as changed. */
export function memoriesWithIds(memories: Memory[]): string {
  return memories
    .map((m) => `[${m.id}]（${m.source === "story" ? "以前" : dayLabel(m.day)}）${m.body.trim()}${m.changed.trim() ? `（后来：${m.changed.trim()}）` : ""}`)
    .join("\n");
}

export async function memoryCounts(): Promise<{ story: number; moments: number; insights: number }> {
  const db = await sql();
  const rows = await db.query<{ source: string; kind: string; n: number }>(
    `select source, kind, count(*)::int as n from qr_memories group by source, kind`,
  );
  let story = 0;
  let moments = 0;
  let insights = 0;
  for (const r of rows) {
    if (r.source === "story") story += Number(r.n);
    else if (r.kind === "insight") insights += Number(r.n);
    else moments += Number(r.n);
  }
  return { story, moments, insights };
}

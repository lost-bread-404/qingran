import { now } from "./clock.ts";
import { localDay } from "./time.ts";
import { sql } from "./store.ts";
import { backgroundOf, buildIndex, fitScores, rankDocs, type Background, type SearchIndex } from "./memory-search.ts";
import { cosine, embedConfig, embedTexts } from "./embed.ts";
import { fromStored, modelFacingText } from "../message-meta.ts";
import { DEFAULT_FORMATS, fmt, type Formats } from "./prompts/formats.ts";

/**
 * 清然's memory (docs/brain.md v6): only what changes how he acts or thinks later, a handful at a time.
 * - story: cut from the storyline Rosie wrote (what happened before this app), paragraph by paragraph, her words as written;
 * - night: events (one per topic; a topic that continues on another day is merged into its event) and insights (what
 *   he understood about Rosie), written each night from that day's talk;
 * - inner: what he wrote in ｛｝, shown to him for 16 hours and never recalled.
 * Her complaints about him go to qr_feedback, not here.
 * `knows`: empty when 清然 knows it; otherwise the others who were there without him (「林泽」). Such a memory comes
 * back only while one of them is in the scene (recall's `present`), so 清然 alone never knows it.
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

/** 清然 knows it, or someone who knows it is in the scene now. */
export function knownHere(m: { knows: string }, present: readonly string[]): boolean {
  return !m.knows || m.knows.split(" ").some((n) => present.includes(n));
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

/** The same, each with its vector of meaning for the current embedding model (or null). */
async function listMemoriesWithVectors(model: string): Promise<Array<Memory & { vec: number[] | null }>> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, kind, source, day, at::float8 as at, seq, body, keys, thread, importance, changed, recalled, knows,
            case when vec_model = $1 then vec else null end as vec
     from qr_memories where source <> 'inner'
     order by (source = 'story') desc, seq asc, coalesce(at, 0) asc, id asc`,
    [model],
  );
  return rows.map((r) => ({ ...rowOf(r), vec: parseVec(r.vec) }));
}

/** A real[] as the driver hands it back: an array, or the text form "{0.1,0.2,…}". */
function parseVec(raw: unknown): number[] | null {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.startsWith("{") ? raw.slice(1, -1).split(",") : null;
  if (!list?.length) return null;
  const vec = list.map(Number);
  return vec.every(Number.isFinite) ? vec : null;
}

/** What a memory's vector is made from: what happened, and the words for finding it again. */
function vectorText(m: { body: string; keys: string; thread: string }): string {
  return [m.body, m.keys, m.thread].map((t) => t.trim()).filter(Boolean).join("\n");
}

/**
 * Gives every memory that has none (or one from another model) its vector, a batch at a time.
 * Runs after replies and after the night pass; a failure just leaves them for next time.
 */
export async function embedMissing(limit = 64): Promise<number> {
  const config = embedConfig();
  if (!config) return 0;
  const db = await sql();
  const rows = await db.query<{ id: number; body: string; keys: string; thread: string }>(
    `select id, body, keys, thread from qr_memories where source <> 'inner' and (vec is null or vec_model <> $1) order by id asc limit $2`,
    [config.model, limit],
  );
  if (!rows.length) return 0;
  const vecs = await embedTexts(rows.map((r) => vectorText({ body: String(r.body), keys: String(r.keys ?? ""), thread: String(r.thread ?? "") })));
  if (!vecs) return 0;
  for (let i = 0; i < rows.length; i += 1) {
    await db.query(`update qr_memories set vec = $2::real[], vec_model = $3 where id = $1`, [Number(rows[i]!.id), vecs[i]!, config.model]);
  }
  memoryCache = null;
  return rows.length;
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
  memoryCache = null;
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
    await db.query(`update qr_memories set body = $2, vec = null, updated_at = $3 where id = $1`, [id, patch.body.trim().slice(0, 4000), ts]);
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
  memoryCache = null;
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
type Indexed = { memories: Memory[]; vecs: Map<number, number[]>; index: SearchIndex };
let memoryCache: ({ key: string } & Indexed) | null = null;

async function background(): Promise<Background> {
  if (backgroundCache && Date.now() - backgroundCache.at < BACKGROUND_TTL_MS) return backgroundCache.value;
  const db = await sql();
  const rows = await db.query<{ body: string; meta: unknown }>(
    `select body, meta from qingran_messages where kind is distinct from 'system_notice' order by created_at desc limit $1`,
    [BACKGROUND_MESSAGES],
  );
  const value = backgroundOf(
    rows
      .map((r) => fromStored(r.body, r.meta))
      .filter((m) => !m.meta.nightNoise)
      .map((m) => modelFacingText(m)),
  );
  backgroundCache = { at: Date.now(), value };
  return value;
}

async function memoryIndex(): Promise<Indexed> {
  const bg = await background();
  const model = embedConfig()?.model ?? "";
  const db = await sql();
  const stamp = await db.query<{ n: number; t: number; v: number }>(
    `select count(*)::int as n, coalesce(max(updated_at), 0)::float8 as t, count(vec)::int as v from qr_memories`,
  );
  const key = `${stamp[0]?.n ?? 0}:${stamp[0]?.t ?? 0}:${stamp[0]?.v ?? 0}:${backgroundCache?.at ?? 0}:${model}`;
  if (memoryCache && memoryCache.key === key) return memoryCache;
  const rows = await listMemoriesWithVectors(model);
  const vecs = new Map<number, number[]>();
  for (const r of rows) if (r.vec?.length) vecs.set(r.id, r.vec);
  const memories: Memory[] = rows.map(({ vec: _vec, ...m }) => m);
  const index = buildIndex(
    memories.map((m) => ({ id: m.id, text: m.body, keys: `${m.keys} ${m.thread}`, importance: m.importance, at: m.at, recalled: m.recalled })),
    bg,
  );
  memoryCache = { key, memories, vecs, index };
  return memoryCache;
}

/** How many come back at once, and how well a moment has to fit to come back at all. */
const RECALL_TOP = 4;
const RECALL_WITH_THREAD = 2;
/** Words alone (no vectors): BM25 fit needed, and the share of the best fit a moment must reach. */
const RECALL_MIN_FIT = 12;
const RECALL_KEEP_SHARE = 0.5;
/** With vectors: how close in meaning a moment must be, and how far below the best one it may fall. */
const RECALL_MIN_COS = 0.48;
const RECALL_COS_BAND = 0.1;
/** How long the reply waits for the vector of her line before going on with words alone. */
const QUERY_EMBED_MS = 1500;

export type Recall = { memories: Memory[]; scores: Array<{ id: number; score: number }>; by: "meaning" | "words" | "none" };

type RecallOpts = {
  top?: number;
  minFit?: number;
  keepShare?: number;
  withThread?: number;
  minCos?: number;
  /** Others in the scene now (「林泽」): their own memories can come back too. */
  present?: readonly string[];
};

const DAY_MS = 86_400_000;

/** Small lifts on top of how well a moment fits: important ones, recent ones, ones that often came back. */
function lift(m: Memory, nowMs: number): number {
  const ageDays = m.at == null ? 365 : Math.max(0, (nowMs - m.at) / DAY_MS);
  return 0.006 * Math.max(1, Math.min(10, m.importance)) + 0.03 * Math.exp(-ageDays / 30) + 0.002 * Math.min(10, m.recalled);
}

/**
 * What comes back to him now: the few moments that fit best — by meaning when vectors are there (words still help:
 * a name she says lifts the moments that name it), by words alone otherwise — plus, for the best ones, the moment
 * just before on the same line (what led up to it), shown in the order they happened.
 */
export async function recall(query: string, nowMs = now(), opts: RecallOpts = {}): Promise<Recall> {
  if (!query.trim()) return { memories: [], scores: [], by: "none" };
  const indexed = await memoryIndex();
  const { index, vecs } = indexed;
  const present = opts.present ?? [];
  const memories = indexed.memories.filter((m) => knownHere(m, present));
  if (!memories.length) return { memories: [], scores: [], by: "none" };
  const top = opts.top ?? RECALL_TOP;
  const minFit = opts.minFit ?? RECALL_MIN_FIT;
  let picked: Array<{ id: number; score: number }> = [];
  let by: Recall["by"] = "words";

  const queryVec = vecs.size ? (await embedTexts([query.slice(-4000)], QUERY_EMBED_MS))?.[0] ?? null : null;
  if (queryVec) {
    by = "meaning";
    const fits = fitScores(index, query);
    const scored: Array<{ id: number; score: number; cos: number }> = [];
    for (const m of memories) {
      const v = vecs.get(m.id);
      const fit = fits.get(m.id) ?? 0;
      const words = Math.min(1, fit / minFit);
      // A moment without a vector yet (written since the last batch) can still come back on its words.
      const cos = v ? cosine(queryVec, v) : words >= 1 ? opts.minCos ?? RECALL_MIN_COS : 0;
      if (cos < (opts.minCos ?? RECALL_MIN_COS)) continue;
      scored.push({ id: m.id, cos, score: cos + 0.05 * words + lift(m, nowMs) });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    const band = opts.keepShare === 0 ? Number.POSITIVE_INFINITY : RECALL_COS_BAND;
    picked = scored.filter((h) => h.score >= best - band).slice(0, top);
  } else {
    const ranked = rankDocs(index, query, nowMs, minFit);
    const first = ranked[0];
    if (first) {
      const share = opts.keepShare ?? RECALL_KEEP_SHARE;
      picked = ranked.filter((h) => h.fit >= first.fit * share).slice(0, top);
    }
  }
  if (!picked.length) return { memories: [], scores: [], by };

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
    scores: picked.map((h) => ({ id: h.id, score: Math.round(h.score * 1000) / 1000 })),
    by,
  };
}

function dayLabel(day: string): string {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[2])}月${Number(m[3])}日` : day;
}

function whenOf(m: Memory, f: Formats): string {
  return (m.source !== "story" && dayLabel(m.day)) || fmt(f, "undated", {});
}

function laterOf(m: Memory, f: Formats): string {
  return fmt(f, "later", { changed: m.changed.trim() });
}

/** The recalled moments as he is given them (材料的写法: 想起来的事 / 想起来的看懂的 / 后来 / 只有别人知道). */
export function recallText(memories: Memory[], f: Formats = DEFAULT_FORMATS): string {
  return memories
    .map((m) => {
      const knows = fmt(f, "recallKnows", { names: (m.knows ?? "").split(" ").filter(Boolean).join("、") });
      const line =
        m.kind === "insight"
          ? fmt(f, "recallInsight", { when: whenOf(m, f), body: m.body.trim() })
          : fmt(f, "recall", { when: whenOf(m, f), knows, body: m.body.trim() });
      return line + laterOf(m, f);
    })
    .join("\n");
}

/** Memories with ids, for the night pass to see what it may merge into (材料的写法: 以前的事 / 以前看懂的). */
export function memoriesWithIds(memories: Memory[], f: Formats = DEFAULT_FORMATS): string {
  return memories
    .map(
      (m) =>
        fmt(f, m.kind === "insight" ? "memoryInsight" : "memory", {
          id: m.id,
          when: whenOf(m, f),
          thread: fmt(f, "thread", { thread: m.thread.trim() }),
          knows: fmt(f, "memoryKnows", { names: m.knows ?? "" }),
          body: m.body.trim(),
        }) + laterOf(m, f),
    )
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

/** What he wrote inside ｛｝ lately (a game answer, his hand): shown back to him every turn, not left to recall. */
const INNER_KEEP_MS = 16 * 3_600_000;

/**
 * What he wrote in ｛｝ this turn: never shown or spoken; he sees it again with the clock for 16 hours, then the night
 * pass has the day. It is not recalled later: plans he made in passing ("晚上再…") came back every turn for a day and
 * kept pulling him toward them.
 */
/** Notes written while Grok was playing her (亲热 scene): Claude is not given them (docs/claude-grok-routing.md). */
export const GROK_SCENE_THREAD = "亲热";

export async function keepInner(notes: string, atMs: number, timeZone: string, grokScene = false): Promise<void> {
  const body = notes.trim();
  if (!body) return;
  await addMemories([
    { kind: "moment", source: "inner", day: localDay(atMs, timeZone), at: atMs, body, importance: 3, thread: grokScene ? GROK_SCENE_THREAD : "" },
  ]).catch((err) => console.error(err));
}

/** His ｛｝ notes of the last 16 hours, oldest first; `grok`: written while Grok was playing her (Claude is not given those). */
export async function recentInner(nowMs = now()): Promise<Array<{ body: string; at: number; grok: boolean }>> {
  const db = await sql();
  const rows = await db.query<{ body: string; thread: string | null; at: number | string }>(
    `select body, thread, at from (
       select body, thread, at, id from qr_memories where source = 'inner' and at > $1 and at <= $2 order by at desc, id desc limit 8
     ) t order by at asc, id asc`,
    [nowMs - INNER_KEEP_MS, nowMs],
  );
  return rows
    .map((r) => ({ body: String(r.body).trim(), at: Number(r.at) || 0, grok: r.thread === GROK_SCENE_THREAD }))
    .filter((r) => r.body);
}

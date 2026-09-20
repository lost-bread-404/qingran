/**
 * Daily retrieval / cache metrics. Called from writeDailyDigest; also:
 *   node --import ./scripts/eval/register-alias.mjs --experimental-strip-types scripts/metrics/daily.ts 2026-09-16
 */
import MiniSearch from "minisearch";
import { getSql } from "../../src/lib/db.ts";
import { tokenizeMemory } from "../../src/lib/lover/brain/text.ts";
import { FALLBACK_MIN_SCORE } from "../../src/lib/lover/brain/voice/retrieve.ts";

export type DailyMetrics = {
  fallback_rate_jump: number | null;
  fallback_rate_nojump: number | null;
  mind_churn: number | null;
  stale_rate: number | null;
  reflect_fail_rate: number | null;
  cache_hit: Record<string, number>;
  blockB_churn: number | null;
  dead_note_ratio: number | null;
  paraphrase_recall_at_30: number | null;
};

function ratio(num: number, den: number): number | null {
  if (!den) return null;
  return num / den;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function asBool(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1;
}

function asStrArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return [];
}

function memoryIdsOf(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const ids = (data as { memory_ids?: unknown }).memory_ids;
  return asStrArr(ids);
}

export async function computeDailyMetrics(day: string): Promise<DailyMetrics> {
  const db = await getSql();
  const turns = await db.query<{
    jump: boolean;
    query_ids: unknown;
    mind_stale: boolean;
    reflect_ok: boolean | null;
  }>(
    `select jump, query_ids, mind_stale, reflect_ok from brain_turns where local_day = $1 order by turn_seq`,
    [day],
  );

  const jumpTurns = turns.filter((t) => asBool(t.jump));
  const noJumpTurns = turns.filter((t) => !asBool(t.jump));
  const nonempty = (t: { query_ids: unknown }) => asStrArr(t.query_ids).length > 0;

  const reflected = turns.filter((t) => t.reflect_ok === true || t.reflect_ok === false);

  const minds = await db.query<{ data: unknown }>(
    `select h.data from qr_mind_history h
     join brain_turns t on t.turn_seq = h.turn_seq
     where t.local_day = $1
     order by h.turn_seq`,
    [day],
  );
  const churns: number[] = [];
  for (let i = 1; i < minds.length; i++) {
    churns.push(jaccard(memoryIdsOf(minds[i - 1]!.data), memoryIdsOf(minds[i]!.data)));
  }

  const logs = await db.query<{ route: string | null; tokens_in: number | null; tokens_cached: number | null }>(
    `select route, tokens_in, tokens_cached from brain_log
     where at >= $1 and at < $2`,
    [Date.parse(`${day}T00:00:00Z`) - 12 * 3_600_000, Date.parse(`${day}T00:00:00Z`) + 36 * 3_600_000],
  );
  const byRoute = new Map<string, { in: number; cached: number }>();
  for (const l of logs) {
    const route = l.route || "other";
    const cur = byRoute.get(route) ?? { in: 0, cached: 0 };
    cur.in += Number(l.tokens_in) || 0;
    cur.cached += Number(l.tokens_cached) || 0;
    byRoute.set(route, cur);
  }
  const cache_hit: Record<string, number> = {};
  for (const [route, v] of byRoute) {
    if (v.in > 0) cache_hit[route] = v.cached / v.in;
  }

  const reflectLogs = await db.query<{ h: string | null }>(
    `select l.refs->>'blockBHash' as h
     from brain_log l
     join brain_turns t on t.turn_seq = l.turn_seq
     where l.route = 'reflect' and t.local_day = $1
     order by l.turn_seq, l.id`,
    [day],
  );
  let blockChanges = 0;
  let blockPairs = 0;
  for (let i = 1; i < reflectLogs.length; i++) {
    blockPairs += 1;
    if ((reflectLogs[i]!.h ?? "") !== (reflectLogs[i - 1]!.h ?? "")) blockChanges += 1;
  }

  const notes = await db.query<{
    id: string;
    text: string;
    tags: unknown;
    aliases: unknown;
    status: string;
    supersedes: string | null;
    recall_count: number;
    created_at: number;
  }>(
    `select id, text, tags, aliases, status, supersedes, recall_count, created_at from mem_notes`,
  );
  const active = notes.filter((n) => n.status === "active");
  const cutoff = Date.now() - 30 * 86_400_000;
  const dead = active.filter((n) => (Number(n.recall_count) || 0) === 0 && Number(n.created_at) < cutoff);

  const supersededPairs = notes.filter((n) => n.supersedes);
  let paraphraseHits = 0;
  let paraphraseN = 0;
  if (supersededPairs.length) {
    const mini = new MiniSearch({
      fields: ["text", "searchText"],
      storeFields: ["id"],
      tokenize: tokenizeMemory,
      processTerm: (t: string) => t,
      searchOptions: {
        tokenize: tokenizeMemory,
        processTerm: (t: string) => t,
        prefix: true,
        fuzzy: 0.2,
        boost: { text: 3, searchText: 1 },
      },
    });
    mini.addAll(
      notes.map((n) => ({
        id: n.id,
        text: n.text,
        searchText: [n.text, ...asStrArr(n.tags), ...asStrArr(n.aliases)].join(" "),
      })),
    );
    for (const n of supersededPairs) {
      const oldId = String(n.supersedes);
      if (!oldId) continue;
      paraphraseN += 1;
      const hits = mini.search(n.text).filter((h) => String(h.id) !== n.id && (Number(h.score) || 0) >= FALLBACK_MIN_SCORE);
      if (hits.slice(0, 30).some((h) => String(h.id) === oldId)) paraphraseHits += 1;
    }
  }

  return {
    fallback_rate_jump: ratio(jumpTurns.filter(nonempty).length, jumpTurns.length),
    fallback_rate_nojump: ratio(noJumpTurns.filter(nonempty).length, noJumpTurns.length),
    mind_churn: mean(churns),
    stale_rate: ratio(turns.filter((t) => asBool(t.mind_stale)).length, turns.length),
    reflect_fail_rate: ratio(reflected.filter((t) => t.reflect_ok === false).length, reflected.length),
    cache_hit,
    blockB_churn: ratio(blockChanges, blockPairs),
    dead_note_ratio: ratio(dead.length, active.length),
    paraphrase_recall_at_30: ratio(paraphraseHits, paraphraseN),
  };
}

const isMain = process.argv[1] && /metrics\/daily\.ts$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  const day = process.argv[2];
  if (!day) {
    console.error("usage: scripts/metrics/daily.ts YYYY-MM-DD");
    process.exit(1);
  }
  computeDailyMetrics(day)
    .then((m) => {
      console.log(JSON.stringify(m, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

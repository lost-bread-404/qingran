import MiniSearch from "minisearch";
import {
  INDEX_CORE_MAX,
  INDEX_RELATED_MAX,
  PICK_MAX,
  PICK_MIND_SLOTS,
  PICK_QUERY_SLOTS,
  clampRetrieveMinTerms,
} from "../config.ts";
import {
  bumpRecall,
  getMeta,
  getNote,
  heavyRecentNotes,
  listIndexNotes,
  listNotesByIds,
  patchMeta,
} from "../store.ts";
import { tokenizeMemory, formatIndexLine } from "../text.ts";
import type { IndexItem, Note } from "../types.ts";

export { tokenizeMemory, formatIndexLine };

export const FALLBACK_MIN_SCORE = 0.3;

/** Time and glue words. One of these is not a real match. */
const CONTENT_TERM_STOP = new Set([
  "她说", "说今", "今天", "今晚", "明天", "昨天", "现在", "然后",
  "这个", "那个", "什么", "怎么", "我们", "你们", "他们", "自己",
  "一个", "没有", "不是", "就是", "可以", "觉得", "知道", "时候",
  "因为", "所以", "还是", "已经", "但是", "如果", "真的", "可能",
  "应该", "有点", "一下", "一点", "这样", "那样", "以后", "之前",
]);

/** Distinct content words among the terms MiniSearch says matched. */
export function contentMatchCount(terms: readonly string[] | undefined): number {
  const seen = new Set<string>();
  for (const raw of terms ?? []) {
    const term = String(raw).toLowerCase();
    if (!term || CONTENT_TERM_STOP.has(term)) continue;
    const latin = /^[a-z0-9]+$/.test(term);
    if (latin ? term.length < 3 : [...term].length !== 2) continue;
    seen.add(term);
  }
  return seen.size;
}

export type HotPick = {
  notes: Note[];
  mindIds: string[];
  queryIds: string[];
  queryScores: number[];
};

type Cache = {
  version: number;
  items: IndexItem[];
  mini: MiniSearch<IndexItem>;
};

let cache: Cache | null = null;

function buildMini(items: IndexItem[]): MiniSearch<IndexItem> {
  const mini = new MiniSearch<IndexItem>({
    fields: ["text", "searchText"],
    storeFields: ["id", "text", "localDay", "subject"],
    tokenize: tokenizeMemory,
    processTerm: (t) => t,
    searchOptions: {
      tokenize: tokenizeMemory,
      processTerm: (t) => t,
      prefix: true,
      fuzzy: 0.2,
      boost: { text: 3, searchText: 1 },
    },
  });
  mini.addAll(items);
  return mini;
}

export async function getMemoryIndex(): Promise<{ items: IndexItem[]; mini: MiniSearch<IndexItem> }> {
  const meta = await getMeta();
  if (cache && cache.version === meta.notesVersion) {
    return { items: cache.items, mini: cache.mini };
  }
  const items = await listIndexNotes();
  const mini = buildMini(items);
  cache = { version: meta.notesVersion, items, mini };
  return { items, mini };
}

export function noteAsIndex(n: Note, score = 0): IndexItem {
  return {
    id: n.id,
    text: n.text,
    searchText: [n.text, ...n.tags, ...(n.aliases ?? [])].join(" "),
    subject: n.subject,
    lens: n.lens,
    weight: n.weight,
    happenedAt: n.happenedAt,
    localDay: n.localDay,
    recallCount: n.recallCount,
    score,
  };
}

/** 核心集合：同一本地日期内复用 ids。notesVersion 只写入 meta 作记录，不参与失效。 */
export function resolveCoreIndex(
  cached: { version: number; day: string; ids: string[] } | null | undefined,
  notesVersion: number,
  day: string,
  scored: IndexItem[],
): { ids: string[]; refresh: boolean } {
  void notesVersion;
  if (cached && cached.day === day) {
    return { ids: cached.ids, refresh: false };
  }
  return { ids: scored.slice(0, INDEX_CORE_MAX).map((i) => i.id), refresh: true };
}

export function assembleRelatedIndex(opts: {
  coreIds: Set<string>;
  recentHeavy: IndexItem[];
  searchHits: Array<{ id: string; score: number }>;
  itemsById: Map<string, IndexItem>;
  max?: number;
}): IndexItem[] {
  const max = opts.max ?? INDEX_RELATED_MAX;
  const picked: Array<{ item: IndexItem; searchScore: number }> = [];
  const seen = new Set<string>();
  for (const item of opts.recentHeavy) {
    if (opts.coreIds.has(item.id) || seen.has(item.id)) continue;
    picked.push({ item, searchScore: Number.POSITIVE_INFINITY });
    seen.add(item.id);
    if (picked.length >= max) break;
  }
  const hits = [...opts.searchHits].sort((a, b) => b.score - a.score);
  for (const hit of hits) {
    if (picked.length >= max) break;
    if (hit.score < FALLBACK_MIN_SCORE) continue;
    if (opts.coreIds.has(hit.id) || seen.has(hit.id)) continue;
    const item = opts.itemsById.get(hit.id);
    if (!item) continue;
    picked.push({ item, searchScore: hit.score });
    seen.add(hit.id);
  }
  picked.sort((a, b) => b.searchScore - a.searchScore || a.item.id.localeCompare(b.item.id));
  return picked.map((p) => p.item);
}

export async function getCoreIndexItems(day: string): Promise<IndexItem[]> {
  const meta = await getMeta();
  const cached = resolveCoreIndex(meta.coreIndex, meta.notesVersion, day, []);
  if (!cached.refresh) {
    const notes = await listNotesByIds(cached.ids);
    return notes
      .filter((n) => n.status === "active")
      .map((n) => noteAsIndex(n))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  const scored = await listIndexNotes();
  const resolved = resolveCoreIndex(meta.coreIndex, meta.notesVersion, day, scored);
  await patchMeta({ coreIndex: { version: meta.notesVersion, day, ids: resolved.ids } });
  const byId = new Map(scored.map((i) => [i.id, i]));
  return resolved.ids
    .map((id) => byId.get(id))
    .filter((i): i is IndexItem => Boolean(i))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function getRelatedIndexItems(query: string, coreIds: Set<string>): Promise<IndexItem[]> {
  const { items, mini } = await getMemoryIndex();
  const recent = await heavyRecentNotes(7, 4);
  const recentItems = recent.map((n) => noteAsIndex(n)).filter((i) => !coreIds.has(i.id));
  const hits = query.trim() ? mini.search(query) : [];
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const i of recentItems) byId.set(i.id, i);
  return assembleRelatedIndex({
    coreIds,
    recentHeavy: recentItems,
    searchHits: hits.map((h) => ({ id: String(h.id), score: Number(h.score) || 0 })),
    itemsById: byId,
  });
}

export async function pickHotNotes(
  mindIds: string[],
  query: string,
  opts: { dry?: boolean; minTerms?: number } = {},
): Promise<HotPick> {
  const minTerms = clampRetrieveMinTerms(opts.minTerms);
  const mindSlots = PICK_MIND_SLOTS;
  const querySlots = PICK_QUERY_SLOTS;
  const mindNotes = (await listNotesByIds(mindIds)).filter((n) => n.status === "active");
  const mindPart = mindNotes.map((n) => n.id).slice(0, Math.min(mindSlots, PICK_MAX));
  const mindPartSet = new Set(mindPart);

  let queryHits: Array<{ id: string; score: number }> = [];
  if (query.trim()) {
    const { mini } = await getMemoryIndex();
    queryHits = mini
      .search(query)
      .map((hit) => ({
        id: String(hit.id),
        score: Number(hit.score) || 0,
        terms: contentMatchCount(hit.terms),
      }))
      .filter((hit) => hit.terms >= minTerms && !mindPartSet.has(hit.id))
      .sort((a, b) => b.terms - a.terms || b.score - a.score || a.id.localeCompare(b.id))
      .map(({ id, score }) => ({ id, score }));
  }

  const picked = [...mindPart];
  const seen = new Set(picked);
  const queryIds: string[] = [];
  const queryScores: number[] = [];
  for (const hit of queryHits) {
    if (picked.length >= PICK_MAX || queryIds.length >= querySlots || seen.has(hit.id)) continue;
    picked.push(hit.id);
    seen.add(hit.id);
    queryIds.push(hit.id);
    queryScores.push(hit.score);
  }

  const fetched = (await listNotesByIds(picked)).filter((n) => n.status === "active");
  const byId = new Map(fetched.map((n) => [n.id, n]));
  const notes = picked.map((id) => byId.get(id)).filter((n): n is Note => Boolean(n));
  if (!opts.dry) await bumpRecall(notes.map((n) => n.id));
  const kept = new Set(notes.map((n) => n.id));
  return {
    notes,
    mindIds: notes.filter((n) => mindPartSet.has(n.id)).map((n) => n.id),
    queryIds: queryIds.filter((id) => kept.has(id)),
    queryScores: queryScores.filter((_, i) => kept.has(queryIds[i]!)),
  };
}

export async function notesForIds(ids: string[]): Promise<Note[]> {
  const out: Note[] = [];
  for (const id of ids) {
    const n = await getNote(id);
    if (n && n.status === "active") out.push(n);
  }
  return out;
}

export function resetRetrieveCache() {
  cache = null;
}

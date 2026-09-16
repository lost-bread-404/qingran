import MiniSearch from "minisearch";
import { HOT_FALLBACK_K, PICK_MAX } from "../config.ts";
import { bumpRecall, getMeta, getNote, listIndexNotes, listNotesByIds } from "../store.ts";
import { tokenizeMemory, formatIndexLine } from "../text.ts";
import type { IndexItem, Note } from "../types.ts";

export { tokenizeMemory, formatIndexLine };

type Cache = {
  version: number;
  items: IndexItem[];
  mini: MiniSearch<IndexItem>;
};

let cache: Cache | null = null;

function buildMini(items: IndexItem[]): MiniSearch<IndexItem> {
  const mini = new MiniSearch<IndexItem>({
    fields: ["text"],
    storeFields: ["id", "text", "localDay", "subject"],
    tokenize: tokenizeMemory,
    processTerm: (t) => t,
    searchOptions: { tokenize: tokenizeMemory, processTerm: (t) => t, prefix: true, fuzzy: 0.2 },
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

const FALLBACK_MIN_SCORE = 0.3;

export async function pickHotNotes(mindIds: string[], query: string): Promise<Note[]> {
  const { items, mini } = await getMemoryIndex();
  const allowed = new Set(items.map((i) => i.id));
  const picked: string[] = [];
  for (const id of mindIds) {
    if (!allowed.has(id)) continue;
    if (picked.includes(id)) continue;
    picked.push(id);
    if (picked.length >= PICK_MAX) break;
  }
  if (picked.length < PICK_MAX && query.trim()) {
    const hits = mini.search(query, { boost: { text: 2 } });
    for (const hit of hits) {
      if (hit.score < FALLBACK_MIN_SCORE) continue;
      if (picked.includes(hit.id)) continue;
      picked.push(hit.id);
      if (picked.length >= Math.min(PICK_MAX, mindIds.length + HOT_FALLBACK_K)) break;
    }
  }
  const notes = (await listNotesByIds(picked)).filter((n) => n.status === "active");
  void bumpRecall(notes.map((n) => n.id));
  return notes.slice(0, PICK_MAX);
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

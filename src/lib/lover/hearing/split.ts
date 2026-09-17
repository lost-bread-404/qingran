import { SCRIPTED_CATEGORIES } from "./config.ts";

export type SplitLabel = "dev" | "test";

export function assignSplits<T extends { id: string; category?: string | null }>(
  clips: T[],
  ratio = 0.7,
  seed = 42,
): Map<string, SplitLabel> {
  const groups = new Map<string, T[]>();
  for (const clip of clips) {
    const key = clip.category || "_none";
    const list = groups.get(key) ?? [];
    list.push(clip);
    groups.set(key, list);
  }
  const out = new Map<string, SplitLabel>();
  let salt = 0;
  for (const key of [...groups.keys()].sort()) {
    const list = (groups.get(key) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
    shuffle(list, seed + salt);
    salt += 1;
    const cut = Math.round(list.length * ratio);
    list.forEach((clip, i) => {
      out.set(clip.id, i < cut ? "dev" : "test");
    });
  }
  return out;
}

export function knownCategory(id: string | null | undefined): boolean {
  if (!id) return false;
  return SCRIPTED_CATEGORIES.some((c) => c.id === id);
}

function shuffle<T>(list: T[], seed: number) {
  let t = seed >>> 0;
  for (let i = list.length - 1; i > 0; i -= 1) {
    t = (Math.imul(t, 1664525) + 1013904223) >>> 0;
    const j = t % (i + 1);
    const tmp = list[i]!;
    list[i] = list[j]!;
    list[j] = tmp;
  }
}

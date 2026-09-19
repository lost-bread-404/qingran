export type SplitLabel = "dev" | "test";

/** FNV-1a over id; ratio 0.8 → 80% dev / 20% test. Stable across exports. */
export function hashSplit(id: string, ratio = 0.8): SplitLabel {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 < ratio * 0x100000000 ? "dev" : "test";
}

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

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


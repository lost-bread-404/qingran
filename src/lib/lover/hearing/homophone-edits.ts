import { pinyin } from "pinyin-pro";
import { extractConfusionPairs } from "./confusions.ts";

/** Same sound ignoring tone, same number of characters. */
export function sameSound(a: string, b: string): boolean {
  if (!a || !b || a === b || [...a].length !== [...b].length) return false;
  const pa = pinyin(a, { toneType: "none", type: "array" });
  const pb = pinyin(b, { toneType: "none", type: "array" });
  return pa.length === pb.length && pa.every((p, i) => p === pb[i]);
}

/** The swaps in an edit that are homophones (e.g. 清然 → 轻燃). */
export function homophoneSwaps(before: string, after: string): Array<{ wrong: string; correct: string }> {
  return extractConfusionPairs(before, after).filter((pair) => sameSound(pair.wrong, pair.correct));
}

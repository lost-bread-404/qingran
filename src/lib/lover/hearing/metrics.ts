import { stripCueTags, type HearingCue, type HearingModelOutput } from "./schema.ts";

export function cer(ref: string, hyp: string): number {
  const a = [...normalizeChars(ref)];
  const b = [...normalizeChars(hyp)];
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[a.length]![b.length]! / a.length;
}

export function cueTokenF1(gold: HearingCue[], pred: HearingCue[]): { p: number; r: number; f1: number } {
  const g = countTokens(gold);
  const p = countTokens(pred);
  let tp = 0;
  for (const [token, n] of p) tp += Math.min(n, g.get(token) ?? 0);
  const predN = [...p.values()].reduce((s, n) => s + n, 0);
  const goldN = [...g.values()].reduce((s, n) => s + n, 0);
  const precision = predN ? tp / predN : 1;
  const recall = goldN ? tp / goldN : 1;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { p: precision, r: recall, f1 };
}

export function fieldAccuracy(
  gold: HearingCue[],
  pred: HearingCue[],
  field: "contour" | "emotion",
): number {
  const pairs = matchCues(gold, pred);
  if (pairs.length === 0) return gold.length === 0 && pred.length === 0 ? 1 : 0;
  let ok = 0;
  for (const [g, p] of pairs) if (g[field] === p[field]) ok += 1;
  return ok / pairs.length;
}

export function binaryPr(
  gold: boolean[],
  pred: boolean[],
): { precision: number; recall: number } {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < gold.length; i += 1) {
    if (gold[i] && pred[i]) tp += 1;
    else if (!gold[i] && pred[i]) fp += 1;
    else if (gold[i] && !pred[i]) fn += 1;
  }
  return {
    precision: tp + fp ? tp / (tp + fp) : 1,
    recall: tp + fn ? tp / (tp + fn) : 1,
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export function selfConsistency(a: HearingModelOutput, b: HearingModelOutput) {
  const textAgree = 1 - cer(a.text, b.text);
  const tokens = cueTokenF1(a.cues, b.cues).f1;
  const contour = fieldAccuracy(a.cues, b.cues, "contour");
  const emotion = fieldAccuracy(a.cues, b.cues, "emotion");
  const noise = a.noise_only === b.noise_only ? 1 : 0;
  return { textAgree, tokens, contour, emotion, noise };
}

export function taggedToPlain(text: string): string {
  return stripCueTags(text);
}

function normalizeChars(text: string): string {
  return stripCueTags(text).replace(/[，。！？、,.!?;；：:\s………~～"'“”‘’]+/g, "");
}

function countTokens(cues: HearingCue[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const cue of cues) map.set(cue.token, (map.get(cue.token) ?? 0) + 1);
  return map;
}

function matchCues(gold: HearingCue[], pred: HearingCue[]): Array<[HearingCue, HearingCue]> {
  const used = new Set<number>();
  const pairs: Array<[HearingCue, HearingCue]> = [];
  for (const g of gold) {
    const idx = pred.findIndex((p, i) => !used.has(i) && p.token === g.token);
    if (idx < 0) continue;
    used.add(idx);
    pairs.push([g, pred[idx]!]);
  }
  return pairs;
}

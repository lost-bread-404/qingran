import { stripCueTags } from "./schema.ts";

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

const TONE_MARKS = new Set(["～", "…", "！", "？"]);

export function normalizeChars(text: string): string {
  return stripCueTags(text).replace(/[，。！？、,.!?;；：:\s………~～"'“”‘’]+/g, "");
}

export function textsExact(ref: string, hyp: string): boolean {
  return normalizeChars(ref) === normalizeChars(hyp);
}

export function normalizeToneMarks(text: string): string {
  return stripCueTags(text)
    .replace(/\.{3,}|…+/g, "…")
    .replace(/~/g, "～")
    .replace(/!/g, "！")
    .replace(/\?/g, "？");
}

export function hasCueToneMarks(text: string): boolean {
  return [...normalizeToneMarks(text)].some((ch) => TONE_MARKS.has(ch));
}

export function cueToneMarks(text: string): string {
  return [...normalizeToneMarks(text)].filter((ch) => TONE_MARKS.has(ch)).join("");
}

export function toneMarksMatch(gold: string, hyp: string): boolean {
  return cueToneMarks(gold) === cueToneMarks(hyp);
}


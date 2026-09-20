import { stripCueTags } from "./schema.ts";

export const CONFUSION_MIN_COUNT = 2;
export const CONFUSION_MAX_CHARS = 6;
export const CONFUSION_EXAMPLE_CAP = 5;

export type ConfusionExample = {
  hyp: string;
  gold: string;
  clipId?: string;
};

export type ConfusionRule = {
  id: string;
  wrong: string;
  correct: string;
  count: number;
  examples: ConfusionExample[];
  enabled: boolean;
};

export type ConfusionHit = {
  wrong: string;
  correct: string;
};

export function confusionId(wrong: string, correct: string): string {
  return `${wrong}→${correct}`;
}

export function extractConfusionPairs(hyp: string, gold: string): ConfusionHit[] {
  const a = [...normalize(hyp)];
  const b = [...normalize(gold)];
  if (!a.length && !b.length) return [];
  const ops = align(a, b);
  const pairs: ConfusionHit[] = [];
  let wrong = "";
  let correct = "";
  const flush = () => {
    const w = wrong;
    const c = correct;
    wrong = "";
    correct = "";
    if (!w || !c || w === c) return;
    if (w.length > CONFUSION_MAX_CHARS || c.length > CONFUSION_MAX_CHARS) return;
    if (punctOnly(w) || punctOnly(c)) return;
    pairs.push({ wrong: w, correct: c });
  };
  for (const op of ops) {
    if (op.type === "eq") {
      flush();
      continue;
    }
    if (op.type === "sub" || op.type === "del") wrong += op.a ?? "";
    if (op.type === "sub" || op.type === "ins") correct += op.b ?? "";
  }
  flush();
  return pairs;
}

export function applyConfusions(
  text: string,
  rules: Array<Pick<ConfusionRule, "wrong" | "correct" | "count" | "enabled">>,
): { text: string; replacements: ConfusionHit[] } {
  const active = rules
    .filter((rule) => rule.enabled !== false && rule.count >= CONFUSION_MIN_COUNT)
    .filter((rule) => rule.wrong && rule.correct && rule.wrong !== rule.correct)
    .sort((a, b) => b.wrong.length - a.wrong.length || a.wrong.localeCompare(b.wrong));
  let out = text;
  const replacements: ConfusionHit[] = [];
  const seen = new Set<string>();
  for (const rule of active) {
    if (!out.includes(rule.wrong)) continue;
    const next = out.split(rule.wrong).join(rule.correct);
    if (next === out) continue;
    const key = confusionId(rule.wrong, rule.correct);
    if (seen.has(key)) continue;
    seen.add(key);
    replacements.push({ wrong: rule.wrong, correct: rule.correct });
    out = next;
    if (replacements.length >= 20) break;
  }
  return { text: out, replacements };
}

export function isActiveConfusion(rule: Pick<ConfusionRule, "count" | "enabled">): boolean {
  return rule.enabled !== false && rule.count >= CONFUSION_MIN_COUNT;
}

export function parseExamples(value: unknown): ConfusionExample[] {
  if (!Array.isArray(value)) return [];
  const out: ConfusionExample[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const hyp = typeof row.hyp === "string" ? row.hyp : "";
    const gold = typeof row.gold === "string" ? row.gold : "";
    if (!hyp && !gold) continue;
    out.push({
      hyp,
      gold,
      clipId: typeof row.clipId === "string" ? row.clipId : undefined,
    });
    if (out.length >= CONFUSION_EXAMPLE_CAP) break;
  }
  return out;
}

function normalize(text: string): string {
  return stripCueTags(text).replace(/\s+/g, "");
}

function punctOnly(text: string): boolean {
  return !text || /^[，。！？、,.!?;；：:\s………~～"'“”‘’]+$/.test(text);
}

type Op = { type: "eq" | "sub" | "del" | "ins"; a?: string; b?: string };

function align(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i += 1) dp[i]![0] = i;
  for (let j = 0; j <= m; j += 1) dp[0]![j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && dp[i]![j] === dp[i - 1]![j - 1]) {
      ops.push({ type: "eq", a: a[i - 1], b: b[j - 1] });
      i -= 1;
      j -= 1;
      continue;
    }
    if (i > 0 && j > 0 && dp[i]![j] === dp[i - 1]![j - 1]! + 1) {
      ops.push({ type: "sub", a: a[i - 1], b: b[j - 1] });
      i -= 1;
      j -= 1;
      continue;
    }
    if (i > 0 && dp[i]![j] === dp[i - 1]![j]! + 1) {
      ops.push({ type: "del", a: a[i - 1] });
      i -= 1;
      continue;
    }
    ops.push({ type: "ins", b: b[j - 1] });
    j -= 1;
  }
  ops.reverse();
  return ops;
}

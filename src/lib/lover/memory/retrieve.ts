import { MAX_CANDIDATES, type Retrievable } from "./types.ts";

const DAY = 86_400_000;

const STOP = new Set([
  "我",
  "你",
  "他",
  "她",
  "它",
  "的",
  "了",
  "在",
  "是",
  "就",
  "都",
  "也",
  "还",
  "很",
  "吗",
  "呢",
  "吧",
  "啊",
  "哦",
  "嗯",
  "不",
  "没",
  "和",
  "与",
  "或",
  "这",
  "那",
  "有",
  "要",
  "会",
  "想",
  "说",
  "看",
  "听",
  "给",
  "到",
  "从",
  "对",
  "把",
  "被",
  "让",
  "去",
  "来",
  "又",
  "能",
  "好",
  "自己",
  "什么",
  "怎么",
  "我们",
  "你们",
  "他们",
  "今天",
  "明天",
  "昨天",
  "现在",
  "已经",
  "真的",
  "一下",
  "一点",
  "一些",
  "这样",
  "那样",
  "因为",
  "所以",
  "如果",
  "而且",
  "还是",
  "没有",
  "可以",
  "知道",
  "觉得",
  "the",
  "and",
  "you",
  "to",
]);

export function extractKeywords(text: string): string[] {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z][a-z0-9]{1,}/g) ?? []) {
    if (!STOP.has(word)) out.add(word);
  }
  const cjk = [...lower].filter((ch) => /\p{Script=Han}/u.test(ch));
  for (const n of [2, 3, 4]) {
    for (let i = 0; i <= cjk.length - n; i += 1) {
      const gram = cjk.slice(i, i + n).join("");
      if (STOP.has(gram)) continue;
      if ([...gram].every((ch) => STOP.has(ch))) continue;
      out.add(gram);
    }
  }
  return [...out].slice(0, 64);
}

export function retrieveCandidates(opts: {
  query: string;
  items: Retrievable[];
  now: number;
  limit?: number;
}): Retrievable[] {
  const limit = opts.limit ?? MAX_CANDIDATES;
  const terms = extractKeywords(opts.query);
  if (terms.length === 0) return [];

  const scored: Array<{ item: Retrievable; score: number }> = [];
  for (const item of opts.items) {
    const score = relevance(item, terms, opts.now);
    if (score <= 0) continue;
    scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score || b.item.endedAt - a.item.endedAt);
  const picked: Retrievable[] = [];
  for (const row of scored) {
    if (picked.some((item) => nearDuplicate(item.text, row.item.text))) continue;
    picked.push(row.item);
    if (picked.length >= limit) break;
  }
  return picked;
}

export function buildQuery(userText: string, recent: string[]): string {
  return [userText, ...recent.slice(-8)].filter(Boolean).join("\n");
}

function relevance(item: Retrievable, terms: string[], now: number): number {
  const hay = item.text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (hay.includes(term)) hits += term.length >= 3 ? 2 : 1;
  }
  if (hits === 0) return 0;

  let score = hits * 10;
  if (item.layer === "l3") score += 5;
  else if (item.layer === "l2") score += 3;
  if (item.status === "active") score += 2;
  const age = Math.max(0, now - item.endedAt);
  if (age < 14 * DAY) score += 4;
  else if (age < 90 * DAY) score += 2;
  else if (age < 365 * DAY) score += 1;
  return score;
}

function nearDuplicate(a: string, b: string): boolean {
  const na = a.replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, "").toLowerCase();
  const nb = b.replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, "").toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

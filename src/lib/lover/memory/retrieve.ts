import {
  MAX_CANDIDATES,
  PATTERN_DORMANT_MS,
  type Retrievable,
} from "./types.ts";

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
  "一下",
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
  for (let i = 0; i < cjk.length - 1; i += 1) {
    const gram = cjk[i]! + cjk[i + 1]!;
    if (!STOP.has(gram) && !STOP.has(cjk[i]!) && !STOP.has(cjk[i + 1]!)) {
      out.add(gram);
    }
  }
  return [...out].slice(0, 40);
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

  const matched: Retrievable[] = [];
  for (const item of opts.items) {
    if (item.layer === "l3") {
      if (item.status !== "active") continue;
      if (opts.now - item.endedAt > PATTERN_DORMANT_MS) continue;
    }
    const hay = item.text.toLowerCase();
    if (!terms.some((term) => hay.includes(term))) continue;
    matched.push(item);
  }

  matched.sort((a, b) => b.endedAt - a.endedAt || b.startedAt - a.startedAt);
  return matched.slice(0, limit);
}

export function buildQuery(userText: string, recent: string[]): string {
  return [userText, ...recent.slice(-6)].filter(Boolean).join("\n");
}

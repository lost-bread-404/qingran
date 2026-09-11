import MiniSearch from "minisearch";
import { MAX_MAIN_MEMORIES, type Retrievable } from "./types.ts";

const PER_TERM = 2;
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

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
  "以后",
  "然后",
  "但是",
  "the",
  "and",
  "you",
  "to",
]);

const CHITCHAT = new Set([
  "吃饭",
  "睡觉",
  "喝水",
  "在吗",
  "你好",
  "哈哈",
  "好的",
  "晚安",
  "早安",
  "散步",
  "上班",
  "回家",
  "累了",
  "没事",
]);

const PRONOUN = /(?:他|她|他们|她们|这事|那事|这个|那个|那件)/;

export function extractKeywords(text: string): string[] {
  return unique(tokenize(text).map(processTerm).filter((term): term is string => Boolean(term)));
}

export function buildQuery(userText: string, recent: string[]): string {
  const primary = userText.trim();
  const keys = extractKeywords(primary);
  if (keys.length === 0) return "";
  if (keys.every((term) => CHITCHAT.has(term))) return "";
  if (keys.length >= 2 || !PRONOUN.test(primary)) return primary;
  const prev = recent.filter((text) => extractKeywords(text).length > 0).slice(-2);
  return [primary, ...prev].join("\n");
}

export function retrieveCandidates(opts: {
  query: string;
  items: Retrievable[];
  now: number;
  limit?: number;
}): Retrievable[] {
  const limit = opts.limit ?? MAX_MAIN_MEMORIES;
  const query = opts.query.trim();
  const queryTerms = extractKeywords(query);
  if (queryTerms.length === 0 || opts.items.length === 0) return [];
  if (queryTerms.every((term) => CHITCHAT.has(term))) return [];

  const byId = new Map(opts.items.map((item) => [item.id, item]));
  const mini = new MiniSearch<Retrievable>({
    fields: ["text"],
    storeFields: ["id"],
    idField: "id",
    tokenize,
    processTerm,
  });
  mini.addAll(opts.items);

  const matched = new Map<string, Set<string>>();
  for (const term of queryTerms) {
    if (CHITCHAT.has(term) && queryTerms.length === 1) continue;
    const hits = mini.search(term, { fuzzy: false, prefix: false, combineWith: "OR" });
    for (const hit of hits) {
      const id = String(hit.id);
      const terms = matched.get(id) ?? new Set<string>();
      terms.add(term);
      matched.set(id, terms);
    }
  }

  const ranked = [...matched.entries()]
    .map(([id, terms]) => ({ item: byId.get(id), terms }))
    .filter((row): row is { item: Retrievable; terms: Set<string> } => Boolean(row.item))
    .sort((a, b) => compareHits(a, b));

  const picked: Retrievable[] = [];
  const used = new Set<string>();
  const termCount = new Map<string, number>();

  const take = (row: { item: Retrievable; terms: Set<string> }): void => {
    if (used.has(row.item.id)) return;
    if (picked.some((item) => nearDuplicate(item.text, row.item.text))) return;
    const saturated = [...row.terms].every((term) => (termCount.get(term) ?? 0) >= PER_TERM);
    if (saturated && picked.length > 0) return;
    used.add(row.item.id);
    picked.push(row.item);
    for (const term of row.terms) termCount.set(term, (termCount.get(term) ?? 0) + 1);
  };

  for (const term of queryTerms) {
    if (picked.length >= limit) break;
    const hit = ranked.find((row) => row.terms.has(term));
    if (hit) take(hit);
  }
  for (const row of ranked) {
    if (picked.length >= limit) break;
    take(row);
  }
  return picked;
}

function compareHits(
  a: { item: Retrievable; terms: Set<string> },
  b: { item: Retrievable; terms: Set<string> },
): number {
  const termDelta = b.terms.size - a.terms.size;
  if (termDelta) return termDelta;
  const layer = (item: Retrievable) => (item.layer === "l3" ? 2 : item.layer === "l2" ? 1 : 0);
  const layerDelta = layer(b.item) - layer(a.item);
  if (layerDelta) return layerDelta;
  return b.item.endedAt - a.item.endedAt || b.item.startedAt - a.item.startedAt;
}

function tokenize(text: string): string[] {
  const words: string[] = [];
  for (const { segment, isWordLike } of segmenter.segment(text.toLowerCase())) {
    const token = segment.trim();
    if (token && isWordLike) words.push(token);
  }
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (!STOP.has(word)) out.push(word);
    const next = words[i + 1];
    if (next && isSingleHan(word) && isSingleHan(next) && !STOP.has(word) && !STOP.has(next)) {
      out.push(word + next);
    }
  }
  return out;
}

function processTerm(term: string): string | null {
  if (!term || STOP.has(term) || isSingleHan(term)) return null;
  return term;
}

function isSingleHan(term: string): boolean {
  return [...term].length === 1 && /\p{Script=Han}/u.test(term);
}

function nearDuplicate(a: string, b: string): boolean {
  const na = a.replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, "").toLowerCase();
  const nb = b.replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, "").toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

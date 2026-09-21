const STOP = new Set([
  "我们",
  "你们",
  "他们",
  "自己",
  "今天",
  "明天",
  "昨天",
  "现在",
  "因为",
  "所以",
  "但是",
  "然后",
  "一个",
  "没有",
  "不是",
  "什么",
  "怎么",
  "这个",
  "那个",
  "可以",
  "还是",
  "已经",
  "真的",
  "就是",
  "还没",
  "一下",
  "一起",
  "东西",
  "时候",
  "地方",
]);

const LATIN = /[A-Z][a-zA-Z]{2,15}/g;

export type TermDoc = { text: string };

type Cache = { key: string; terms: string[] };
let cache: Cache | null = null;

export function memoryFingerprint(docs: TermDoc[]): string {
  return docs
    .map((d) => d.text.trim())
    .filter(Boolean)
    .join("\n");
}

export function extractTfIdfTerms(docs: TermDoc[], limit = 50): string[] {
  const key = memoryFingerprint(docs);
  if (cache && cache.key === key) return cache.terms.slice(0, limit);
  const tokenized = docs
    .map((d) => tokenize(d.text))
    .filter((tokens) => tokens.length);
  const n = tokenized.length || 1;
  const df = new Map<string, number>();
  const tf = new Map<string, number>();
  for (const tokens of tokenized) {
    const seen = new Set<string>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
      if (!seen.has(token)) {
        seen.add(token);
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
  }
  const scored = [...tf.entries()]
    .map(([term, termTf]) => {
      const idf = Math.log((n + 1) / ((df.get(term) ?? 1) + 1)) + 1;
      return { term, score: termTf * idf };
    })
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const terms = scored.map((s) => s.term).slice(0, limit);
  cache = { key, terms };
  return terms;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const term = raw.trim().slice(0, 50);
    if (term.length < 2 || STOP.has(term) || seen.has(term)) return;
    seen.add(term);
    out.push(term);
  };
  for (const match of text.match(LATIN) ?? []) add(match);
  const runs = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of runs) {
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i <= run.length - n; i += 1) {
        add(run.slice(i, i + n));
      }
    }
  }
  return out;
}

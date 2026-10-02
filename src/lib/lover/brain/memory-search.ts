/**
 * Finding the moments that fit what Rosie is saying now, without a model call.
 * Chinese has no spaces, so text is cut into overlapping two-character pieces (plus whole latin words);
 * each moment is matched on its words and its keys (people, places, feelings, other words for it, written by the
 * night pass so a different way of saying the same thing still finds it). BM25 decides how well a moment fits;
 * importance, how recent it is and how often it came back to him lift it a little.
 */

export type SearchDoc = {
  id: number;
  text: string;
  keys: string;
  importance: number;
  /** When it happened (ms), or null for the story. */
  at: number | null;
  recalled: number;
};

export type SearchHit = { id: number; score: number; fit: number };

const K1 = 1.2;
const B = 0.75;

export function terms(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const m of lower.matchAll(/[a-z0-9]{2,}/g)) out.push(m[0]);
  for (const m of lower.matchAll(/[㐀-鿿]+/g)) {
    const run = m[0];
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

function counts(list: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of list) map.set(t, (map.get(t) ?? 0) + 1);
  return map;
}

export type SearchIndex = {
  docs: Array<SearchDoc & { tf: Map<string, number>; len: number }>;
  df: Map<string, number>;
  /** Documents behind df: the moments plus the background talk. */
  n: number;
  avgLen: number;
};

/**
 * How often each piece shows up in their recent talk (one message = one document). Words she and he say all the time
 * (姐姐, 小猫, 抱着) then count for little, and the ones that name something (林泽, 项圈, 面试) count for more.
 */
export type Background = { df: Map<string, number>; n: number };

export function backgroundOf(texts: string[]): Background {
  const df = new Map<string, number>();
  for (const text of texts) for (const t of new Set(terms(text))) df.set(t, (df.get(t) ?? 0) + 1);
  return { df, n: texts.length };
}

export function buildIndex(docs: SearchDoc[], background: Background = { df: new Map(), n: 0 }): SearchIndex {
  const df = new Map(background.df);
  const rows = docs.map((doc) => {
    // Keys count twice: they are the words the night pass chose for finding it again.
    const list = [...terms(doc.text), ...terms(doc.keys), ...terms(doc.keys)];
    const tf = counts(list);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { ...doc, tf, len: list.length };
  });
  const avgLen = rows.length ? rows.reduce((n, r) => n + r.len, 0) / rows.length : 1;
  return { docs: rows, df, n: rows.length + background.n, avgLen: avgLen || 1 };
}

/** How well each doc fits the query (BM25), before importance and time. */
export function fitScores(index: SearchIndex, query: string): Map<number, number> {
  const q = counts(terms(query));
  const n = index.n;
  const out = new Map<number, number>();
  for (const doc of index.docs) {
    let s = 0;
    for (const [t, qf] of q) {
      const f = doc.tf.get(t);
      if (!f) continue;
      const df = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / index.avgLen))) * Math.min(qf, 3);
    }
    if (s > 0) out.set(doc.id, s);
  }
  return out;
}

const DAY = 86_400_000;

export function rankDocs(index: SearchIndex, query: string, nowMs: number, minFit: number): SearchHit[] {
  const fits = fitScores(index, query);
  const hits: SearchHit[] = [];
  for (const doc of index.docs) {
    const fit = fits.get(doc.id) ?? 0;
    if (fit < minFit) continue;
    const ageDays = doc.at == null ? 365 : Math.max(0, (nowMs - doc.at) / DAY);
    const recency = 0.85 + 0.3 * Math.exp(-ageDays / 30);
    const weight = 0.6 + 0.08 * Math.max(1, Math.min(10, doc.importance));
    const echo = 1 + 0.03 * Math.min(10, doc.recalled);
    hits.push({ id: doc.id, fit, score: fit * weight * recency * echo });
  }
  return hits.sort((a, b) => b.score - a.score);
}

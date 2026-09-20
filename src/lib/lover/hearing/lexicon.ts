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
const PHRASE_MIN = 3;
const PHRASE_MAX = 16;
const WORD_MIN = 2;
const WORD_MAX = 6;

export const LEXICON_WORD_CAP = 200;
export const LEXICON_PHRASE_CAP = 50;
export const LEXICON_PHRASE_MIN_COUNT = 3;
export const LEXICON_STALE_MS = 24 * 60 * 60 * 1000;

export type LexiconEntry = {
  kind: "word" | "phrase";
  term: string;
  count: number;
};

export type LexiconDoc = { text: string };

export function buildPersonalLexicon(docs: LexiconDoc[]): LexiconEntry[] {
  const wordTf = new Map<string, number>();
  const phraseTf = new Map<string, number>();
  for (const doc of docs) {
    const text = (doc.text ?? "").trim();
    if (!text) continue;
    for (const token of lexiconWords(text)) {
      wordTf.set(token, (wordTf.get(token) ?? 0) + 1);
    }
    const phrase = lexiconPhrase(text);
    if (phrase) phraseTf.set(phrase, (phraseTf.get(phrase) ?? 0) + 1);
  }
  const words = rank(wordTf, LEXICON_WORD_CAP).map((row) => ({
    kind: "word" as const,
    term: row.term,
    count: row.count,
  }));
  const phrases = rank(phraseTf, LEXICON_PHRASE_CAP)
    .filter((row) => row.count >= LEXICON_PHRASE_MIN_COUNT)
    .map((row) => ({ kind: "phrase" as const, term: row.term, count: row.count }));
  return [...words, ...phrases];
}

export function lexiconWords(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const term = raw.trim().slice(0, 50);
    if (term.length < WORD_MIN || STOP.has(term) || seen.has(term)) return;
    if (/[\u4e00-\u9fff]/.test(term) && term.length > WORD_MAX) return;
    if (!/[\u4e00-\u9fff]/.test(term) && term.length > 16) return;
    seen.add(term);
    out.push(term);
  };
  for (const match of text.match(LATIN) ?? []) add(match);
  const runs = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of runs) {
    for (let n = WORD_MIN; n <= Math.min(WORD_MAX, run.length); n += 1) {
      for (let i = 0; i <= run.length - n; i += 1) add(run.slice(i, i + n));
    }
  }
  return out;
}

export function lexiconPhrase(text: string): string | null {
  const core = text
    .replace(/〔[^〕]*〕/g, "")
    .replace(/[，。！？、,.!?;；：:\s………~～"'“”‘’]+/g, "");
  if (core.length < PHRASE_MIN || core.length > PHRASE_MAX) return null;
  if (!/[\u4e00-\u9fff]/.test(core)) return null;
  if (STOP.has(core)) return null;
  return core.slice(0, 50);
}

function rank(tf: Map<string, number>, cap: number): Array<{ term: string; count: number }> {
  return [...tf.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, cap);
}

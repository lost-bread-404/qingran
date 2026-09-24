import { isNightNoiseBody, modelFacingText } from "../../message-markup.ts";

export const RECENT_REPLY_LIMIT = 8;
export const RECENT_PHRASE_LIMIT = 8;
export const RECENT_PHRASE_MIN_CHARS = 6;

const FILLER_EDGE =
  "哈哈|呵呵|嘿嘿|哎呀|哎哟|呜呜|嗯+|啊+|呀+|哦+|噢+|呢+|啦+|嘛+|哈+|唉+|哎+|诶+|喂+|呜+|唔+|嘿+|哼+|哇+|哟+|呦+|嘞+|喽+|呐+|呗+|喔+|嗷+|咦+|嘻+|呃+";
const FILLER_PREFIX = new RegExp(`^(?:${FILLER_EDGE})`);
const FILLER_SUFFIX = new RegExp(`(?:${FILLER_EDGE})$`);

/** Drop punctuation and modal particles so near-copies compare equal. */
export function normalizeForRepeat(text: string): string {
  const chunks = text.normalize("NFKC").split(/[\s,.;:!?，。！？、；：…—\-~～·"'“”‘’「」『』（）()\[\]【】《》<>]+/);
  return chunks.map(stripEdgeFillers).filter(Boolean).join("");
}

function stripEdgeFillers(chunk: string): string {
  let s = chunk.trim();
  let prev = "";
  while (s && s !== prev) {
    prev = s;
    s = s.replace(FILLER_PREFIX, "").replace(FILLER_SUFFIX, "");
  }
  if (s.length > 2 && /[了吧]$/.test(s)) s = s.slice(0, -1);
  if (s.length > 2 && /^[了吧]/.test(s)) s = s.slice(1);
  return s;
}

function cleanSurface(text: string): string {
  return text.replace(/^[\s，。！？、；：,.\-!?;…~～「」『』"“”]+|[\s，。！？、；：,.\-!?;…~～「」『』"“”]+$/g, "").trim();
}

type Kind = "reply" | "sentence" | "clause" | "pair";

function tallyReply(text: string): Map<string, { n: number; surface: string }> {
  const byNorm = new Map<string, { kinds: Map<Kind, number>; surface: string }>();
  const add = (kind: Kind, surface: string) => {
    const norm = normalizeForRepeat(surface);
    if (norm.length < RECENT_PHRASE_MIN_CHARS) return;
    const clean = cleanSurface(surface);
    if (!clean) return;
    const row = byNorm.get(norm) ?? { kinds: new Map<Kind, number>(), surface: clean };
    row.kinds.set(kind, (row.kinds.get(kind) ?? 0) + 1);
    if (clean.length < row.surface.length) row.surface = clean;
    byNorm.set(norm, row);
  };
  add("reply", text);
  const sentences = text
    .split(/[。！？!?；;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    add("sentence", sentence);
    const clauses = sentence
      .split(/[，,、]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const clause of clauses) add("clause", clause);
    for (let i = 0; i < clauses.length - 1; i++) add("pair", `${clauses[i]}，${clauses[i + 1]}`);
  }
  const out = new Map<string, { n: number; surface: string }>();
  for (const [norm, row] of byNorm) {
    out.set(norm, { n: Math.max(...row.kinds.values()), surface: row.surface });
  }
  return out;
}

/**
 * Repeated sentences or phrases from recent replies.
 * A hit must be at least 6 characters after normalization and occur at least twice.
 */
export function recentRepeatedPhrases(replies: string[]): string[] {
  const source = replies
    .map((reply) => reply.trim())
    .filter(Boolean)
    .slice(-RECENT_REPLY_LIMIT);
  const hits = new Map<string, { n: number; surface: string }>();
  for (const reply of source) {
    for (const [norm, row] of tallyReply(reply)) {
      const prev = hits.get(norm);
      if (!prev) {
        hits.set(norm, { n: row.n, surface: row.surface });
        continue;
      }
      prev.n += row.n;
      if (row.surface.length < prev.surface.length) prev.surface = row.surface;
    }
  }
  const candidates = [...hits.entries()].filter(([, hit]) => hit.n >= 2);
  candidates.sort((a, b) => b[0].length - a[0].length || b[1].n - a[1].n);
  const kept: Array<[string, { n: number; surface: string }]> = [];
  for (const item of candidates) {
    const covered = kept.some(([norm, hit]) => hit.n === item[1].n && norm.includes(item[0]));
    if (!covered) kept.push(item);
  }
  kept.sort((a, b) => b[1].n - a[1].n || b[0].length - a[0].length || a[1].surface.localeCompare(b[1].surface, "zh"));
  return kept.slice(0, RECENT_PHRASE_LIMIT).map(([, hit]) => clipSurface(hit.surface));
}

function clipSurface(text: string): string {
  if (text.length <= 80) return text;
  return `${text.slice(0, 80)}…`;
}

export function assistantReplyTexts(history: Array<{ role: string; text: string }>): string[] {
  return history
    .filter((message) => message.role === "assistant" && !isNightNoiseBody(message.text))
    .map((message) => modelFacingText(message.text).trim())
    .filter(Boolean);
}

export function recentPhrasesFromHistory(history: Array<{ role: string; text: string }>): string[] {
  return recentRepeatedPhrases(assistantReplyTexts(history).slice(-RECENT_REPLY_LIMIT));
}

export function formatRecentPhrases(phrases: string[]): string {
  return phrases.map((phrase) => `「${phrase.replace(/[「」]/g, "")}」`).join("");
}

/** When nothing repeated, drop every line that still contains the placeholder. */
export function omitEmptyRecentPhraseBlock(text: string, phraseText: string): string {
  if (phraseText.trim() || !text.includes("{recent_phrases}")) return text;
  return text
    .split(/\n\n+/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .filter((line) => !line.includes("{recent_phrases}"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}

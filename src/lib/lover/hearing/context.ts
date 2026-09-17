import { stripCueTags } from "./schema.ts";

export type ContextTurn = {
  role: "user" | "assistant";
  text: string;
};

const NAME_RE = /[A-Z][a-zA-Z]{2,15}/g;
const QUOTED_RE = /[“「『"]([^“」』"]{2,12})[”」』"]/g;
const CALLED_RE = /(?:叫|名叫|是)\s*([\u4e00-\u9fffA-Za-z]{2,8})/g;
const CJK_NAME_RE = /[\u4e00-\u9fff]{2,4}/g;

export function stripHearingMarkup(text: string): string {
  return stripAltTags(stripCueTags(text));
}

export function stripAltTags(text: string): string {
  return text.replace(/\{([^|{}]+)\|[^}]+\}/g, "$1");
}

export function buildHearingContext(messages: ContextTurn[], take = 4): string {
  const recent = messages.filter((m) => m.text.trim()).slice(-take);
  if (!recent.length) return "";
  const lines = recent.map((m) => {
    const who = m.role === "assistant" ? "清然" : "Rosie";
    return `${who}：${stripHearingMarkup(m.text).trim()}`;
  });
  const lastAssistant = [...recent].reverse().find((m) => m.role === "assistant");
  const lastLine = lastAssistant
    ? `清然上一句：${stripHearingMarkup(lastAssistant.text).trim()}`
    : "";
  return [
    "对话上下文：",
    ...lines,
    lastLine,
    "用上下文消解同音字歧义，但不要凭上下文补全音频里没有的字。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function extractContextKeyterms(context: string, limit = 50): string[] {
  if (!context) return [];
  const found = new Set<string>();
  for (const match of context.match(NAME_RE) ?? []) found.add(match);
  for (const match of context.match(QUOTED_RE) ?? []) {
    const inner = match.replace(/[“”「」『』"]/g, "").trim();
    if (inner.length >= 2 && inner.length <= 12) found.add(inner);
  }
  for (const match of context.match(CALLED_RE) ?? []) {
    const name = match.replace(/^(?:叫|名叫|是)\s*/, "");
    if (name.length >= 2) found.add(name);
  }
  return [...found].filter((t) => t.length >= 2 && t.length <= 50).slice(0, limit);
}

export function mergeKeyterms(...lists: Array<string[] | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const raw of list ?? []) {
      const term = raw.trim().slice(0, 50);
      if (term.length < 2 || seen.has(term)) continue;
      seen.add(term);
      out.push(term);
      if (out.length >= 100) return out;
    }
  }
  return out;
}

export { CJK_NAME_RE };

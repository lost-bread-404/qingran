import { fillParagraphs } from "./doc.ts";
import { FORMATS } from "./templates.ts";

/**
 * 「材料的写法」 (指令 page): how each piece of material is written. One line per piece, 「名字：写法」.
 * A line she deleted or broke falls back to the default one.
 */
const NAMES = {
  gap: "停顿",
  photo: "照片",
  recall: "想起来的事",
  recallInsight: "想起来的看懂的",
  later: "后来",
  undated: "没有日期",
  memory: "以前的事",
  memoryInsight: "以前看懂的",
  thread: "话题",
  recallKnows: "想起来时只有别人知道",
  memoryKnows: "以前的事只有别人知道",
  nightLine: "夜里整理的一句",
  reportDay: "月报的一天",
  reportLine: "月报的一句",
  reportTimeline: "月报的时间线",
  grokScene: "亲热",
  innerLine: "心里记着的一句",
} as const;

export type FormatKey = keyof typeof NAMES;
export type Formats = Record<FormatKey, string>;

function parse(text: string): Partial<Formats> {
  const byName = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.search(/[：:]/);
    if (at > 0) byName.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const out: Partial<Formats> = {};
  for (const [key, name] of Object.entries(NAMES) as Array<[FormatKey, string]>) {
    const got = byName.get(name);
    if (got !== undefined) out[key] = got;
  }
  return out;
}

export const DEFAULT_FORMATS: Formats = parse(FORMATS) as Formats;

export function parseFormats(text: string): Formats {
  return { ...DEFAULT_FORMATS, ...parse(text) };
}

/** One piece written out. Empty when every {…} in it is empty (the same rule as the instructions). */
export function fmt(f: Formats, key: FormatKey, vars: Record<string, string | number>): string {
  const text = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)]));
  return fillParagraphs(f[key] ?? DEFAULT_FORMATS[key], text);
}

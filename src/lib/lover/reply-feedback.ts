export const REPLY_DOWN_TAGS = ["没懂我", "太强势", "空话", "太长", "太短", "重复", "出戏"] as const;

export type ReplyDownTag = (typeof REPLY_DOWN_TAGS)[number];

const ALLOWED = new Set<string>(REPLY_DOWN_TAGS);

export function isReplyDownTag(value: unknown): value is ReplyDownTag {
  return typeof value === "string" && ALLOWED.has(value);
}

export function clampReplyDownTags(raw: unknown): ReplyDownTag[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ReplyDownTag[] = [];
  for (const item of list) {
    if (!isReplyDownTag(item)) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export function countReplyDownTags(rows: Array<{ tags?: readonly string[] }>): Array<{ tag: ReplyDownTag; n: number }> {
  const counts = new Map<ReplyDownTag, number>(REPLY_DOWN_TAGS.map((tag) => [tag, 0]));
  for (const row of rows) {
    for (const tag of clampReplyDownTags(row.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return REPLY_DOWN_TAGS.map((tag) => ({ tag, n: counts.get(tag) ?? 0 }));
}

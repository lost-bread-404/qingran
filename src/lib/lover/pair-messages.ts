import { type ChatMessage } from "./types.ts";

export type ChatPair = {
  user?: ChatMessage;
  assistant?: ChatMessage;
  /** Every reply to this user message, oldest first. `assistant` is the page on screen. */
  replies?: ChatMessage[];
  note?: ChatMessage;
};

type VariantMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  replyTo?: string;
  activeReply?: string;
  /** Stored messages carry these in meta; the page's messages as fields. */
  meta?: { replyTo?: string; activeReply?: string };
};

function variantLinks(message: VariantMessage): { replyTo?: string; activeReply?: string } {
  return {
    replyTo: message.replyTo || message.meta?.replyTo,
    activeReply: message.activeReply || message.meta?.activeReply,
  };
}

/** Page on screen. The chosen id wins, otherwise the newest reply. */
export function shownReply<T extends { id: string }>(
  user: { activeReply?: string } | undefined,
  replies: T[],
): T | undefined {
  if (!replies.length) return undefined;
  if (user?.activeReply) {
    const hit = replies.find((reply) => reply.id === user.activeReply);
    if (hit) return hit;
  }
  return replies[replies.length - 1];
}

/** Reply that continues the thread. An empty page does not discard a real one. */
export function keptReply<T extends { id: string; text: string }>(
  user: { activeReply?: string } | undefined,
  replies: T[],
): T | undefined {
  const shown = shownReply(user, replies);
  if (!shown) return undefined;
  if (shown.text.trim() || replies.length === 1) return shown;
  const withText = replies.filter((reply) => reply.text.trim());
  return withText.length ? withText[withText.length - 1] : shown;
}

/** Drop alternate replies. The kept one stays where the first alternate sat. */
export function collapseReplyVariants<T extends VariantMessage>(messages: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const replyTo = variantLinks(message).replyTo;
    if (!replyTo) continue;
    const list = groups.get(replyTo);
    if (list) list.push(message);
    else groups.set(replyTo, [message]);
  }
  const keep = new Set<string>();
  for (const [userId, replies] of groups) {
    const user = messages.find((message) => message.id === userId);
    const chosen = keptReply(
      user ? { activeReply: variantLinks(user).activeReply } : undefined,
      replies,
    );
    if (chosen) keep.add(chosen.id);
  }
  return messages.filter((message) => {
    if (message.role !== "assistant") return true;
    const replyTo = variantLinks(message).replyTo;
    if (!replyTo) return true;
    return keep.has(message.id);
  });
}

export function unselectedReplyIds(messages: ChatMessage[]): string[] {
  const keep = new Set(collapseReplyVariants(messages).map((message) => message.id));
  return messages
    .filter((message) => message.role === "assistant" && message.replyTo && !keep.has(message.id))
    .map((message) => message.id);
}

export function sortConversation(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => {
    const ta = Number(a.createdAt) || 0;
    const tb = Number(b.createdAt) || 0;
    if (ta !== tb) return ta - tb;
    if (a.role !== b.role) return a.role === "user" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/** Old rows: a sound that was kept but never answered (not her voice). */
export function skipsQingran(msg: ChatMessage): boolean {
  return msg.role === "user" && (msg.kind === "unheard" || Boolean(msg.nightNoise));
}

/** Lay out turns in time order. Replies to the same user message stay on one page stack. */
export function pairMessages(messages: ChatMessage[]): ChatPair[] {
  const pairs: ChatPair[] = [];
  const openById = new Map<string, number>();

  for (const msg of sortConversation(messages)) {
    if (msg.kind === "system_notice") {
      pairs.push({ note: msg });
      continue;
    }
    if (msg.role === "user") {
      if (skipsQingran(msg)) continue;
      pairs.push({ user: msg });
      openById.set(msg.id, pairs.length - 1);
      continue;
    }
    const idx = msg.replyTo ? openById.get(msg.replyTo) : undefined;
    if (idx != null) {
      const pair = pairs[idx]!;
      const replies = pair.replies ? [...pair.replies, msg] : [msg];
      pair.replies = replies;
      pair.assistant = shownReply(pair.user, replies);
      continue;
    }
    if (msg.text.trim()) pairs.push({ assistant: msg, replies: [msg] });
  }
  return pairs;
}

/** The talk up to a message, the message, and what came after it. */
export function sliceAfterMessage<T extends { id: string }>(messages: T[], id: string) {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  return {
    history: messages.slice(0, idx),
    current: messages[idx]!,
    removed: messages.slice(idx + 1),
  };
}

export function dropIncompleteReplies(
  messages: ChatMessage[],
  keepIds?: Iterable<string>,
): ChatMessage[] {
  const keep = keepIds ? new Set(keepIds) : null;
  const next = [...messages];
  while (next.length) {
    const last = next[next.length - 1];
    if (last?.role === "assistant" && !last.text.trim() && !keep?.has(last.id) && !last.interrupted) {
      next.pop();
      continue;
    }
    break;
  }
  return next;
}
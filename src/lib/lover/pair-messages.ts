import type { ChatMessage } from "./types";

export type ChatPair = {
  user?: ChatMessage;
  assistant?: ChatMessage;
  note?: ChatMessage;
};

export function sortConversation(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => {
    const ta = Number(a.createdAt) || 0;
    const tb = Number(b.createdAt) || 0;
    if (ta !== tb) return ta - tb;
    if (a.role !== b.role) return a.role === "user" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/** Zip each user line to the next unmatched reply so turns stay 1-1. */
export function pairMessages(messages: ChatMessage[]): ChatPair[] {
  const pairs: ChatPair[] = [];
  const unmatched: number[] = [];

  for (const msg of messages) {
    if (msg.kind === "steer" || msg.kind === "setting") {
      pairs.push({ note: msg });
      continue;
    }
    if (msg.role === "user") {
      pairs.push({ user: msg });
      unmatched.push(pairs.length - 1);
      continue;
    }
    const idx = unmatched.shift();
    if (idx != null) {
      pairs[idx]!.assistant = msg;
    } else if (msg.text.trim()) {
      pairs.push({ assistant: msg });
    }
  }
  return pairs;
}

export function dropIncompleteReplies(
  messages: ChatMessage[],
  keepIds?: Iterable<string>,
): ChatMessage[] {
  const keep = keepIds ? new Set(keepIds) : null;
  const next = [...messages];
  while (next.length) {
    const last = next[next.length - 1];
    if (last?.role === "assistant" && !last.text.trim() && !keep?.has(last.id)) {
      next.pop();
      continue;
    }
    break;
  }
  return next;
}

import { UNRECOGNIZED_TEXT } from "./hearing/heard.ts";
import { CONTEXT_WINDOW, type ChatMessage } from "./types.ts";

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

export function skipsQingran(msg: ChatMessage): boolean {
  if (msg.role !== "user") return false;
  if (msg.kind === "unheard") return true;
  return msg.text.trim() === UNRECOGNIZED_TEXT;
}

export function historyForQingran(messages: ChatMessage[], limit = CONTEXT_WINDOW): ChatMessage[] {
  return messages
    .filter((msg) => msg.kind !== "steer" && msg.kind !== "setting" && !skipsQingran(msg))
    .slice(-limit);
}

/** Lay out turns in time order. Replies attach to `replyTo` when present; unheard users never take a reply. */
export function pairMessages(messages: ChatMessage[]): ChatPair[] {
  const pairs: ChatPair[] = [];
  const openById = new Map<string, number>();

  for (const msg of sortConversation(messages)) {
    if (msg.kind === "steer" || msg.kind === "setting") {
      pairs.push({ note: msg });
      continue;
    }
    if (msg.role === "user") {
      pairs.push({ user: msg });
      if (!skipsQingran(msg)) openById.set(msg.id, pairs.length - 1);
      continue;
    }
    const idx = msg.replyTo ? openById.get(msg.replyTo) : undefined;
    if (idx != null && !pairs[idx]!.assistant) {
      pairs[idx]!.assistant = msg;
      openById.delete(msg.replyTo!);
      continue;
    }
    if (msg.text.trim()) pairs.push({ assistant: msg });
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

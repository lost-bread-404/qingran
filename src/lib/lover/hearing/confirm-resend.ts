import { UNRECOGNIZED_TEXT } from "./heard.ts";

export function lastUserMessage<T extends { id: string; role?: string; kind?: string }>(
  messages: T[],
): T | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "user" && msg.kind !== "steer" && msg.kind !== "setting") return msg;
  }
  return null;
}

export function goldTextForSave(raw: string): string {
  const text = raw.trim();
  if (!text || text === UNRECOGNIZED_TEXT) return "";
  return text;
}

export function displayConfirmText(goldText: string): string {
  return goldTextForSave(goldText) || UNRECOGNIZED_TEXT;
}

export function confirmNoiseOnly(input: {
  goldText: string;
  noiseOnly: boolean;
  events?: readonly string[] | null;
}): boolean {
  if (input.noiseOnly) return true;
  if (goldTextForSave(input.goldText)) return false;
  return !input.events?.length;
}

export function confirmKind(input: { noiseOnly: boolean; goldText: string }): "unheard" | "say" {
  if (input.noiseOnly) return "unheard";
  const text = goldTextForSave(input.goldText);
  if (!text) return "unheard";
  return "say";
}

export function shouldResendAfterConfirm(input: {
  goldText: string;
  previousText: string;
  noiseOnly: boolean;
  isLastUser: boolean;
}): boolean {
  if (!input.isLastUser || input.noiseOnly) return false;
  const next = goldTextForSave(input.goldText);
  if (!next) return false;
  return next !== input.previousText.trim();
}

export function sliceAfterMessage<T extends { id: string }>(messages: T[], id: string) {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  return {
    history: messages.slice(0, idx),
    current: messages[idx]!,
    removed: messages.slice(idx + 1),
  };
}

export function planConfirmSave<T extends { id: string; role?: string; kind?: string; text: string }>(
  messages: T[],
  msg: T,
  input: { goldText: string; noiseOnly: boolean; events?: readonly string[] | null },
): { updated: T; shouldResend: boolean; removed: T[] } {
  const goldText = goldTextForSave(input.goldText);
  const noiseOnly = confirmNoiseOnly({
    goldText: input.goldText,
    noiseOnly: input.noiseOnly,
    events: input.events,
  });
  const updated = {
    ...msg,
    text: displayConfirmText(goldText),
    kind: confirmKind({ noiseOnly, goldText }),
  };
  const isLastUser = lastUserMessage(messages)?.id === msg.id;
  const shouldResend = shouldResendAfterConfirm({
    goldText,
    previousText: msg.text,
    noiseOnly,
    isLastUser,
  });
  const dropReply = Boolean(isLastUser && !shouldResend && !goldText);
  const sliced = shouldResend || dropReply ? sliceAfterMessage(messages, msg.id) : null;
  return { updated, shouldResend, removed: sliced?.removed ?? [] };
}

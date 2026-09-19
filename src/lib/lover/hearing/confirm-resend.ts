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

export function confirmKind(input: { noiseOnly: boolean; goldText: string }): "unheard" | "say" {
  if (input.noiseOnly) return "unheard";
  const text = input.goldText.trim();
  if (!text || text === UNRECOGNIZED_TEXT) return "unheard";
  return "say";
}

export function shouldResendAfterConfirm(input: {
  goldText: string;
  previousText: string;
  noiseOnly: boolean;
  isLastUser: boolean;
}): boolean {
  if (!input.isLastUser || input.noiseOnly) return false;
  const next = input.goldText.trim();
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
  input: { goldText: string; noiseOnly: boolean },
): { updated: T; shouldResend: boolean; removed: T[] } {
  const goldText = input.goldText.trim() || msg.text;
  const updated = {
    ...msg,
    text: goldText,
    kind: confirmKind({ noiseOnly: input.noiseOnly, goldText }),
  };
  const shouldResend = shouldResendAfterConfirm({
    goldText,
    previousText: msg.text,
    noiseOnly: input.noiseOnly,
    isLastUser: lastUserMessage(messages)?.id === msg.id,
  });
  const sliced = shouldResend ? sliceAfterMessage(messages, msg.id) : null;
  return { updated, shouldResend, removed: sliced?.removed ?? [] };
}

export function shouldResendAfterConfirm(input: {
  goldText: string;
  previousText: string;
  noiseOnly: boolean;
}): boolean {
  if (input.noiseOnly) return false;
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

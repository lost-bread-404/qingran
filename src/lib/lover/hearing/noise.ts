export function xaiHasSpeech(xaiText?: string | null): boolean {
  return Boolean((xaiText ?? "").trim());
}

export function isNoiseDisagreement(providerNoiseOnly: boolean, xaiText?: string | null): boolean {
  return Boolean(providerNoiseOnly && xaiHasSpeech(xaiText));
}

/** Drop the turn only when the adapter says noise AND xAI heard nothing. */
export function shouldDropAsNoise(providerNoiseOnly: boolean, xaiText?: string | null): boolean {
  return Boolean(providerNoiseOnly && !xaiHasSpeech(xaiText));
}

export const GOLD_SOURCES = ["confirmed", "edited"] as const;
export type GoldSource = (typeof GOLD_SOURCES)[number];

export function isGoldSource(value: unknown): value is GoldSource {
  return value === "confirmed" || value === "edited";
}

export function goldTierFor(input: {
  source?: string | null;
  emotionSet?: boolean;
  hasCues?: boolean;
}): number {
  if (input.hasCues) return 3;
  if (input.emotionSet) return 2;
  if (input.source === "confirmed" || input.source === "edited") return 1;
  return 0;
}


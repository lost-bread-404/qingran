import { JUMP_SCORE_MAX } from "../config.ts";
import { tokenizeMemory } from "../text.ts";
import type { Mind } from "../types.ts";

function mindContextText(mind: Mind): string {
  return [mind.rosie_now, mind.undercurrent, ...mind.threads, ...mind.lead_plan, mind.intent]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function mindIsBlank(mind: Mind): boolean {
  return !mindContextText(mind);
}

/** Overlap of this utterance with the previous mind. Denominator is the utterance. */
export function topicJump(userText: string, mind: Mind): { score: number; jump: boolean } {
  const A = new Set(tokenizeMemory(userText));
  const rawB = mindContextText(mind);
  if (mindIsBlank(mind) || !rawB || A.size < 4) {
    return { score: 1, jump: false };
  }
  const B = new Set(tokenizeMemory(rawB));
  if (!B.size) return { score: 1, jump: false };
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const score = inter / A.size;
  return { score, jump: score < JUMP_SCORE_MAX };
}

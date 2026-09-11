import { retrieveMemories } from "./memory";
import { buildSystemPrompt, formatClock } from "./prompt";
import type { ChatMessage, DailyImpression, Memory, Portrait, Profile } from "./types";

export function assembleTalkPrompt(input: {
  text: string;
  profile: Profile;
  history: ChatMessage[];
  memories: Memory[];
  portrait?: Portrait;
  daily?: DailyImpression | null;
  nowMs?: number;
  timeZone?: string;
}) {
  const timeZone = input.timeZone || "UTC";
  const clock = formatClock(input.nowMs || Date.now(), timeZone);
  const recent = [...input.history.slice(-6).map((m) => m.text), input.text].join("\n");
  const picked = retrieveMemories(input.memories ?? [], recent);
  return {
    timeZone,
    clock,
    system: buildSystemPrompt(input.profile, picked.retrieved, clock, timeZone, {
      portrait: input.portrait,
      openLoops: picked.openLoops,
      daily: input.daily,
    }),
  };
}

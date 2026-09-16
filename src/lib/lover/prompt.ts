import type { Profile } from "./types";
import { formatClock } from "./brain/time";

export { formatClock };

export function buildSystemPrompt(profile: Profile, clock: string): string {
  const base = profile.systemPrompt.trim() || "你就是清然。正在和 Rosie 语音通话。";
  return `${base}\n\n现在是${clock}。`;
}

export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

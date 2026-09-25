import { NEUTRAL_PERSONA, type Profile } from "./types";
import { defaultPrompt } from "./brain/prompts/catalog.ts";
import { fillTemplate } from "./brain/prompts/fill.ts";

function hearingTagGuideFromVoice(): string {
  return defaultPrompt("voice").replace(/\{system_prompt\}\s*/g, "").trim();
}

export function promptFingerprint(systemPrompt: string): string {
  return fillTemplate(defaultPrompt("voice"), { system_prompt: systemPrompt.trim() }).trim();
}

export function hearingTagGuide(): string {
  return hearingTagGuideFromVoice();
}

export function buildSystemPrompt(profile: Profile, clock: string): string {
  const base = profile.systemPrompt.trim() || NEUTRAL_PERSONA;
  return `${fillTemplate(defaultPrompt("voice"), { system_prompt: base }).trim()}

现在是${clock}。`;
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

export function formatClock(nowMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      weekday: "short",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString();
  }
}

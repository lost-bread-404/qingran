import { sortMemoriesByTime } from "./memory.ts";
import type { ChatMessage, Memory, Profile } from "./types";
import { defaultPrompt } from "./brain/prompts/catalog.ts";
import { parsePromptBody, renderVariant, type PromptDoc, type RenderedMessage } from "./brain/prompts/doc.ts";
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
  const base = profile.systemPrompt.trim() || "你就是清然。正在和 Rosie 语音通话。";
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

function knownMemories(memories: Memory[]): string {
  if (memories.length === 0) return "（还没有）";
  return sortMemoriesByTime(memories)
    .slice(-24)
    .map((m) => `- ${m.text}`)
    .join("\n");
}

function formatChat(list: ChatMessage[]): string {
  return list.map((m) => `${m.role === "user" ? "Rosie" : "清然"}：${m.text}`).join("\n");
}

function promptDoc(key: "remember" | "overflow" | "consolidate", template?: string | PromptDoc): PromptDoc {
  if (template && typeof template !== "string") return template;
  return parsePromptBody(key, template);
}

export function rememberMessages(
  stretch: string,
  memories: Memory[],
  template: string | PromptDoc = defaultPrompt("remember"),
): RenderedMessage[] {
  return renderVariant(promptDoc("remember", template), "main", {
    memories: knownMemories(memories),
    stretch: stretch.slice(0, 1800),
  });
}

export function buildRememberPrompt(
  stretch: string,
  memories: Memory[],
  template: string | PromptDoc = defaultPrompt("remember"),
): string {
  return rememberMessages(stretch, memories, template)
    .map((message) => message.content)
    .join("\n");
}

export function overflowMessages(
  overflow: ChatMessage[],
  lookahead: ChatMessage[],
  memories: Memory[],
  template: string | PromptDoc = defaultPrompt("overflow"),
): RenderedMessage[] {
  return renderVariant(promptDoc("overflow", template), "main", {
    memories: knownMemories(memories),
    overflow: formatChat(overflow).slice(0, 2200),
    lookahead: formatChat(lookahead).slice(0, 800),
  });
}

export function buildOverflowRememberPrompt(
  overflow: ChatMessage[],
  lookahead: ChatMessage[],
  memories: Memory[],
  template: string | PromptDoc = defaultPrompt("overflow"),
): string {
  return overflowMessages(overflow, lookahead, memories, template)
    .map((message) => message.content)
    .join("\n");
}

export function parseRememberResult(raw: string): { facts: string[] } {
  try {
    const parsed = JSON.parse(extractJson(raw)) as { facts?: unknown; events?: unknown };
    return { facts: asStringList(parsed.facts ?? parsed.events).slice(0, 1) };
  } catch {
    return { facts: [] };
  }
}

export function parseOverflowResult(
  raw: string,
  overflowCount: number,
): { fact: string; consumed: number } {
  try {
    const parsed = JSON.parse(extractJson(raw)) as { fact?: unknown; consume?: unknown };
    const fact = typeof parsed.fact === "string" ? parsed.fact.replace(/\s+/g, " ").trim() : "";
    const n = Number(parsed.consume);
    const consumed = Number.isFinite(n)
      ? Math.max(0, Math.min(overflowCount, Math.floor(n)))
      : overflowCount;
    return { fact, consumed };
  } catch {
    return { fact: "", consumed: overflowCount };
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length >= 2)
    .slice(0, 6);
}

export function consolidateMessages(
  memories: Memory[],
  clock: string,
  timeZone = "UTC",
  template: string | PromptDoc = defaultPrompt("consolidate"),
): RenderedMessage[] {
  const list =
    memories.length === 0
      ? "（还没有）"
      : sortMemoriesByTime(memories)
          .map((m, i) => `${i + 1}. [${formatClock(m.createdAt || Date.now(), timeZone)}] ${m.text}`)
          .join("\n");
  return renderVariant(promptDoc("consolidate", template), "main", {
    clock,
    memories: list.slice(0, 6000),
  });
}

export function buildConsolidatePrompt(
  memories: Memory[],
  clock: string,
  timeZone = "UTC",
  template: string | PromptDoc = defaultPrompt("consolidate"),
): string {
  return consolidateMessages(memories, clock, timeZone, template)
    .map((message) => message.content)
    .join("\n");
}

export function parseConsolidateResult(
  raw: string,
): Array<{ text: string; createdAt?: number }> {
  try {
    const parsed = JSON.parse(extractJson(raw)) as { facts?: unknown };
    if (!Array.isArray(parsed.facts)) return [];
    return parsed.facts
      .map((item) => {
        if (typeof item === "string") return { text: item.replace(/\s+/g, " ").trim() };
        if (!item || typeof item !== "object") return { text: "" };
        const row = item as { text?: unknown; at?: unknown; createdAt?: unknown };
        const text = typeof row.text === "string" ? row.text.replace(/\s+/g, " ").trim() : "";
        const at = Number(row.at ?? row.createdAt);
        return {
          text,
          createdAt: Number.isFinite(at) && at > 0 ? at : undefined,
        };
      })
      .filter((item) => item.text.length >= 4)
      .slice(0, 12);
  } catch {
    return [];
  }
}

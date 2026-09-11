import {
  ASSISTANT_SPEAKER,
  USER_SPEAKER,
  type MainPackInput,
  type PackedChatMessage,
  type PackedMemory,
} from "./types.ts";

export function buildMainMessages(pack: MainPackInput): PackedChatMessage[] {
  const messages: PackedChatMessage[] = [
    { role: "system", content: pack.charter.trim() || "你就是清然。正在和 Rosie 语音通话。" },
  ];

  const extra = buildMemorySystem(pack);
  if (extra) messages.push({ role: "system", content: extra });

  for (const turn of pack.history) {
    messages.push(labelChatMessage(turn.role, turn.content));
  }
  messages.push(labelChatMessage("user", pack.userText));
  return messages;
}

export function labelChatMessage(
  role: "user" | "assistant",
  content: string,
): PackedChatMessage {
  const name = role === "assistant" ? ASSISTANT_SPEAKER : USER_SPEAKER;
  return { role, name, content: withSpeaker(name, content) };
}

export function withSpeaker(name: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return `${name}：`;
  if (new RegExp(`^${escapeReg(name)}\\s*[：:]`).test(trimmed)) return trimmed;
  return `${name}：${trimmed}`;
}

export function stripSpeakerPrefix(text: string): string {
  return text.replace(new RegExp(`^\\s*(?:${escapeReg(ASSISTANT_SPEAKER)}|${escapeReg(USER_SPEAKER)})\\s*[：:]\\s*`), "");
}

export function buildMemorySystem(pack: MainPackInput): string {
  const parts: string[] = [];
  if (pack.clock) parts.push(`现在是${pack.clock}。`);
  parts.push("对话里 Rosie 是用户，你是清然。直接说下一句，不要写成「清然：」这种台本。");

  const status = packStatusBlock(pack.portrait);
  if (status) parts.push(status);

  const related = packMemoryBlock(pack.memories);
  if (related) parts.push(related);

  return parts.join("\n\n");
}

export function packStatusBlock(portrait: string): string | null {
  const body = portrait.trim();
  if (!body) return null;
  return `[状态]\n${body}`;
}

export function packMemoryBlock(memories: PackedMemory[]): string | null {
  if (memories.length === 0) return null;
  const lines = memories
    .slice(0, 8)
    .map((item) => {
      const tag = item.dormant ? "休眠 " : "";
      return `${item.time} ${tag}${item.text}`.replace(/\s+/g, " ").trim();
    })
    .filter(Boolean);
  if (lines.length === 0) return null;
  return `【相关记忆】\n${lines.join("\n")}`;
}

export function countChars(text: string): number {
  return [...text].filter((ch) => !/\s/u.test(ch)).length;
}

export function clipPortrait(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (countChars(trimmed) <= maxChars) return trimmed;
  let acc = "";
  let n = 0;
  for (const ch of trimmed) {
    if (!/\s/u.test(ch)) n += 1;
    if (n > maxChars) break;
    acc += ch;
  }
  const cut = acc.lastIndexOf("。");
  return (cut > 80 ? acc.slice(0, cut + 1) : acc).trim();
}

function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

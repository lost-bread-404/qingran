import type { MainPackInput, PackedMemory } from "./types.ts";

export function buildMainMessages(pack: MainPackInput): Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: pack.charter.trim() || "你就是清然。正在和 Rosie 语音通话。" },
  ];

  const extra = buildMemorySystem(pack);
  if (extra) messages.push({ role: "system", content: extra });

  for (const turn of pack.history) {
    messages.push({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: turn.content,
    });
  }
  messages.push({ role: "user", content: pack.userText });
  return messages;
}

export function buildMemorySystem(pack: MainPackInput): string {
  const parts: string[] = [];
  if (pack.clock) parts.push(`现在是${pack.clock}。`);

  const status = packStatusBlock(pack.portrait, pack.openHappening);
  if (status) parts.push(status);

  const related = packMemoryBlock(pack.memories);
  if (related) parts.push(related);

  return parts.join("\n\n");
}

export function packStatusBlock(portrait: string, openHappening: boolean): string | null {
  const body = portrait.trim();
  if (!body && !openHappening) return null;
  const lines = ["[状态]"];
  if (body) lines.push(body);
  if (openHappening) lines.push("目前还有一件未结束的事正在发生。");
  return lines.join("\n");
}

export function packMemoryBlock(memories: PackedMemory[]): string | null {
  if (memories.length === 0) return null;
  const lines = memories
    .slice(0, 5)
    .map((item) => `${item.time} ${item.text}`.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return `【相关记忆】\n${lines.join("\n")}`;
}

export function countChars(text: string): number {
  return [...text].filter((ch) => !/\s/u.test(ch)).length;
}

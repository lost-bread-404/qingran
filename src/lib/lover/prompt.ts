import { sortMemoriesByTime } from "./memory.ts";
import type { ChatMessage, Memory, Profile } from "./types";

const HEARING_TAG_GUIDE = `Rosie 的话有时会带语气标记，不是她打出来的字。格式：字〔长短·走向·声线｜事件〕，例如「嗯〔long·rising·breathy｜〕今天好累」。
〔〕里是听力给出的声音：长短、音高走向、是不是气声。竖线右侧如果有字，是笑、哭、叹气、喘息或猫叫（laugh、cry、sigh、moan、meow），多个事件用 + 连接，例如 〔long·wavering·breathy｜cry+moan〕。没有事件时竖线右侧留空。不是情绪类别。不要念出来，不要写进回复的字面。用它听声音听起来怎样，意思由你根据上下文判断。没有标记就按普通口语听。
有时会出现 {A|B}，表示听力在两个词之间不确定，A 更可能。按更通顺的那个理解，不要把花括号念出来，也不要两个都念。`;

export function promptFingerprint(systemPrompt: string): string {
  return `${systemPrompt.trim()}\n${HEARING_TAG_GUIDE}`;
}

export function buildSystemPrompt(
  profile: Profile,
  memories: Memory[],
  clock: string,
  timeZone = "UTC",
): string {
  const base = profile.systemPrompt.trim() || "你就是清然。正在和 Rosie 语音通话。";
  const memoryBlock =
    memories.length === 0
      ? "（还没有长期记忆）"
      : sortMemoriesByTime(memories)
          .map((item) => `- ${formatClock(item.createdAt || Date.now(), timeZone)}：${item.text}`)
          .join("\n");
  return `${base}

${HEARING_TAG_GUIDE}

现在是${clock}。记忆里的时间是事情发生时的时间，用来判断那是多久以前。

你还记得：
${memoryBlock}`;
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

export function buildRememberPrompt(stretch: string, memories: Memory[]): string {
  const known =
    memories.length === 0
      ? "（还没有）"
      : sortMemoriesByTime(memories)
          .slice(-24)
          .map((m) => `- ${m.text}`)
          .join("\n");
  return `你在给清然写长期记忆。默认什么都不记。只输出 JSON：{"facts":[]}

只记已经发生、会改变以后相处的大事。看整段对话再决定，不要按单句拆，不要把一次互动拆成多条。
一件事只记一条，写成一句完整的话。

要记：分手或提分手、复合、同居或搬家、重要的人进场或离场、失业/找到工作并造成后果、大的情绪崩溃并改变关系、明确的长期约定。
不要记：撒娇、拥抱、亲吻、蹭、日常聊天、心情、一次安慰、场景动作、语气、重复已有记忆、这一句里的细节。

要记的例子：
- Rosie因为找不到工作而情绪崩溃，跟清然提分手
- 林泽因为嫌清然和Rosie太吵而从房子里搬了出去
不要记的例子：
- Rosie在清然的怀里撒娇蹭了蹭
- 清然今晚陪Rosie说话
- Rosie有点累、想被抱

已有记忆（重复的不要再写，同件事不要存两次）：
${known}

这一段对话：
${stretch.slice(0, 1800)}

没有足够大的事，就输出 {"facts":[]}。最多一条 fact。`;
}

export function buildOverflowRememberPrompt(
  overflow: ChatMessage[],
  lookahead: ChatMessage[],
  memories: Memory[],
): string {
  const known =
    memories.length === 0
      ? "（还没有）"
      : sortMemoriesByTime(memories)
          .slice(-24)
          .map((m) => `- ${m.text}`)
          .join("\n");
  const format = (list: ChatMessage[]) =>
    list
      .map((m) => `${m.role === "user" ? "Rosie" : "清然"}：${m.text}`)
      .join("\n");
  return `你在给清然压缩滑出窗口的对话。只输出 JSON：{"fact":"","consume":0}

看 overflow 整段，再用 lookahead 判断这件事有没有说完。
一件已经说完、会改变以后相处的大事，写成一句 fact。没有就 fact 留空。
consume 是 overflow 里已经看完、不必再扫的条数，从前往后数。
事情说完了，就把相关句子都 consume 掉。说到窗口里还没完，就少 consume，留给下一轮。
不要把日常撒娇、拥抱、心情写成 fact。

已有记忆：
${known}

overflow：
${format(overflow).slice(0, 2200)}

lookahead：
${format(lookahead).slice(0, 800)}`;
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

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export function buildConsolidatePrompt(
  memories: Memory[],
  clock: string,
  timeZone = "UTC",
): string {
  const list =
    memories.length === 0
      ? "（还没有）"
      : sortMemoriesByTime(memories)
          .map((m, i) => `${i + 1}. [${formatClock(m.createdAt || Date.now(), timeZone)}] ${m.text}`)
          .join("\n");
  return `你在整理清然的长期记忆。现在是${clock}。只输出 JSON：{"facts":[{"text":"","at":0}]}

把碎的、重复的、同一件事拆开的记忆合并成少数几条关键记忆。
每条 fact 是一句完整的话，写清谁、发生了什么、结果。
at 用原来那件事里最早的 createdAt 毫秒时间戳。没有就省略 at。
不要写撒娇、拥抱、日常语气。不要发明没出现过的事。
最多 12 条。没有可整理的就原样压缩成更短的关键句。

现有记忆：
${list.slice(0, 6000)}`;
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

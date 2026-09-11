export type VoiceId = "eve";
export type SessionStatus = "idle" | "recording" | "thinking" | "speaking" | "error";
export type MessageKind = "say" | "steer" | "setting";

export const CONTEXT_WINDOW = 60;

export type Profile = {
  systemPrompt: string;
  muted: boolean;
  autoRemember: boolean;
  memoryCursor: string;
};

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  kind?: MessageKind;
  scanned?: boolean;
};

export type Memory = {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
};

export const DEFAULT_SYSTEM_PROMPT = `你就是清然。正在和 Rosie 语音通话。

清然，24岁，中国人，INTJ，约翰霍普金斯大学医学院学生。内向、话少、逻辑清楚、深情含蓄、有主见。Rosie 叫她姐姐。她叫 Rosie 小猫。说话自然，不表演，不讨好。

你们住在一起。清然在医学院读书。没有魔法，没有系统，就是两个人的生活。清然是姐姐，Rosie 是她的小猫。关系稳定、亲、可以依赖。

不要每轮都问吃了吗、在干嘛。不要自称 AI。不要复读同一句哼人的话。
直接说出口。不要 JSON，不要 markdown，不要列表标题。动作和场景需要时才写，不要每句都加。
场景、动作、对话分行写，段与段空一行，不要整段挤成一块。
说话像真人打电话，自然停顿。需要时用 [pause] [sigh] [breath]，轻的句子用 <soft>。不要每句都加，不要把标签念出来。`;

export const DEFAULT_PROFILE: Profile = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  muted: false,
  autoRemember: true,
  memoryCursor: "",
};

type LooseProfile = Partial<Profile> & {
  promptOverride?: string;
  promptFrame?: string;
  world?: string;
  persona?: string;
  rules?: string;
  friends?: string;
  story?: string;
  identity?: string;
  muted?: boolean;
  autoRemember?: boolean;
  memoryCursor?: string;
};

export function lockedProfile(input?: unknown): Profile {
  const raw = (input && typeof input === "object" ? input : {}) as LooseProfile;
  return {
    systemPrompt: pickSystemPrompt(raw).slice(0, 16_000),
    muted: Boolean(raw.muted),
    autoRemember: raw.autoRemember !== false,
    memoryCursor: typeof raw.memoryCursor === "string" ? raw.memoryCursor : "",
  };
}

export function applyMemoryCursor(messages: ChatMessage[], cursor: string): ChatMessage[] {
  if (!cursor) return messages;
  const idx = messages.findIndex((m) => m.id === cursor);
  if (idx < 0) return messages;
  return messages.map((m, i) => (i <= idx && !m.scanned ? { ...m, scanned: true } : m));
}

function pickSystemPrompt(input?: LooseProfile | null): string {
  const direct = input?.systemPrompt?.trim();
  if (direct) return direct;
  const override = input?.promptOverride?.trim();
  if (override) return override;
  if (input && (input.persona || input.world || input.promptFrame)) {
    return assembleLegacyPrompt(input);
  }
  return DEFAULT_SYSTEM_PROMPT;
}

function assembleLegacyPrompt(input: LooseProfile): string {
  const chunks = [
    input.world,
    input.persona,
    input.rules,
    input.friends,
    input.story,
    input.identity,
  ]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  if (chunks.length === 0) return DEFAULT_SYSTEM_PROMPT;
  return `你就是清然。正在和 Rosie 语音通话。\n\n${chunks.join("\n\n")}`;
}

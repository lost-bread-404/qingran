import { DEFAULT_HEARING_PROVIDER, isHearingProvider, type HearingProviderId } from "./hearing/config.ts";
import type { AcousticTags } from "./hearing/tags.ts";

export type VoiceId = "eve";
export type SessionStatus = "idle" | "recording" | "thinking" | "speaking" | "error";
export type MessageKind = "say" | "steer" | "setting" | "unheard";

export const CONTEXT_WINDOW = 40;

export type Profile = {
  systemPrompt: string;
  muted: boolean;
  voiceSpeed: number;
  autoRemember: boolean;
  memoryCursor: string;
  hearingProvider: HearingProviderId;
  captureAudio: boolean;
  debugHearing: boolean;
  hearingNbest: boolean;
};

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  kind?: MessageKind;
  scanned?: boolean;
  voiceTurnId?: string;
  replyTo?: string;
  predictedTags?: AcousticTags;
  hearingGold?: "unconfirmed" | "confirmed";
  hearingTiming?: {
    hearMs?: number;
    grokMs?: number;
    ttsMs?: number;
    engine?: string;
  };
  interrupted?: boolean;
  talkTrace?: {
    status?: number | null;
    finishReason?: string | null;
    ms?: number;
    chars?: number;
  };
};

export type Memory = {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
};

export const DEFAULT_SYSTEM_PROMPT = `你就是清然。正在和 Rosie 语音通话。

清然，25岁，2000.12.18生，中国人，INTJ，女alpha，信息素是水生消毒味。约翰霍普金斯医学院 M3 刚结束，2026.9 起在纽约做科研年。表面上情绪稳定、礼貌、温柔、深情含蓄，话少但每句都有用。Rosie 叫她姐姐。她叫 Rosie 小猫。说话自然，不表演。

Rosie，20岁，2005.10.28生，ENTP，女omega，信息素酸甜柑橘。纽约大学计算机大三，在找量化软件工程师实习。表面跳跃调皮傲娇，实际自卑敏感缺爱。你已经标记了她，你们同住一间卧室。

林泽，27岁，男alpha，信息素木质烟草，病理科住院 intern，住同一套另一间卧室。他是你医学院三年室友，也是前辈。

这是 ABO 的世界。omega 很少，会藏。你有一个「恋人匹配系统」，它告诉你 Rosie 是 100% 匹配，还能捕捉她的心声。你永远不会告诉任何人你有这个系统，包括 Rosie 和林泽。通话里不要提系统，不要把它当成可以讨论的设定。

不要每轮都问吃了吗、在干嘛。不要自称 AI。不要复读同一句哼人的话。
直接说出口。不要 JSON，不要 markdown，不要列表标题。动作和场景需要时才写，不要每句都加。
场景、动作、对话分行写，段与段空一行，不要整段挤成一块。
说话像真人打电话，自然停顿。需要时用 [pause] [sigh] [breath]，轻的句子用 <soft>。不要每句都加，不要把标签念出来。`;

export const DEFAULT_PROFILE: Profile = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  muted: false,
  voiceSpeed: 1,
  autoRemember: true,
  memoryCursor: "",
  hearingProvider: DEFAULT_HEARING_PROVIDER,
  captureAudio: true,
  debugHearing: true,
  hearingNbest: false,
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
  voiceSpeed?: number;
  softVoice?: boolean;
  autoRemember?: boolean;
  memoryCursor?: string;
  hearingProvider?: string;
  captureAudio?: boolean;
  debugHearing?: boolean;
  hearingNbest?: boolean;
};

export function lockedProfile(input?: unknown): Profile {
  const raw = (input && typeof input === "object" ? input : {}) as LooseProfile;
  return {
    systemPrompt: pickSystemPrompt(raw).slice(0, 16_000),
    muted: Boolean(raw.muted),
    voiceSpeed: pickVoiceSpeed(raw),
    autoRemember: raw.autoRemember !== false,
    memoryCursor: typeof raw.memoryCursor === "string" ? raw.memoryCursor : "",
    hearingProvider: isHearingProvider(raw.hearingProvider)
      ? raw.hearingProvider
      : DEFAULT_HEARING_PROVIDER,
    debugHearing: raw.debugHearing !== false,
    captureAudio: raw.debugHearing !== false,
    hearingNbest: Boolean(raw.hearingNbest),
  };
}

export function applyMemoryCursor(messages: ChatMessage[], cursor: string): ChatMessage[] {
  if (!cursor) return messages;
  const idx = messages.findIndex((m) => m.id === cursor);
  if (idx < 0) return messages;
  return messages.map((m, i) => (i <= idx && !m.scanned ? { ...m, scanned: true } : m));
}

function pickVoiceSpeed(raw: LooseProfile) {
  if (typeof raw.voiceSpeed === "number" && Number.isFinite(raw.voiceSpeed)) {
    return Math.min(1.5, Math.max(0.7, raw.voiceSpeed));
  }
  if (raw.softVoice) return 0.92;
  return 1;
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

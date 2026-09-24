import { DEFAULT_HEARING_PROVIDER, type HearingProviderId, lockSttKeyterms } from "./hearing/config.ts";
import { HEARING_INSTRUCTION } from "./hearing/instruction.ts";
import type { AcousticTags } from "./hearing/tags.ts";
import { clampNightMinMs, clampNightVoicedRatio, NIGHT_MIN_MS, NIGHT_VOICED_MIN } from "./hearing/night-voice.ts";
import { DEFAULT_HEARING_SENSE, lockHearingSense, type HearingSense } from "./hearing/sense.ts";
import { SILENCE_MS } from "./vad.ts";
import { clampHistoryWindow, clampPortraitActiveMax, clampPortraitStaleDays, clampRetrieveMinTerms, HISTORY_WINDOW, PORTRAIT_ACTIVE_MAX, PORTRAIT_STALE_DAYS, RETRIEVE_MIN_TERMS } from "./brain/config.ts";
import { lockPromptModels, type PromptModelPick } from "./brain/prompts/models.ts";
import type { PromptKey } from "./brain/prompts/catalog.ts";

export { clampHistoryWindow, clampNightMinMs, clampNightVoicedRatio, clampPortraitActiveMax, clampPortraitStaleDays, clampRetrieveMinTerms };
export type { HearingSense };

export type VoiceId = "eve";
export type SessionStatus = "idle" | "recording" | "thinking" | "speaking" | "error";
export type MessageKind = "say" | "steer" | "setting" | "unheard";
export type VoiceEffort = "low" | "medium" | "high" | null;

export const CONTEXT_WINDOW = 40;

export const DEFAULT_VOICE_MODEL = "grok-4.3";
export const DEFAULT_VOICE_EFFORT: VoiceEffort = "low";
export const VOICE_EFFORT_OPTIONS = ["low", "medium", "high"] as const;

export function isVoiceEffort(value: unknown): value is Exclude<VoiceEffort, null> {
  return value === "low" || value === "medium" || value === "high";
}

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
  voiceModel: string;
  voiceEffort: VoiceEffort;
  /** Pause that ends a turn, milliseconds. 800–3000, default 1500. */
  silenceMs: number;
  injectMind: boolean;
  /** Retrieved notes in the voice prompt. Retrieval still runs when this is off. */
  injectMemories: boolean;
  /** Self / bond / portrait block in the voice prompt. */
  injectLongterm: boolean;
  /** Recent messages in the voice prompt, and the archive slide-out window. 0–80. */
  historyWindow: number;
  /** Kept for older profiles. Voice input no longer has a night switch; the pitch gate is always on. */
  nightMode: boolean;
  /** Voiced-frame share below this is noise, day and night. 0–1, default 0.3. */
  nightVoicedMin: number;
  /** Clips shorter than this are noise, day and night. Milliseconds, default 300. */
  nightMinMs: number;
  /** Hearing sensitivity page. Source of truth for VAD, end-wait, noise gate, and tone marks. */
  hearingSense: HearingSense;
  /** Per-instruction chat model. Missing keys keep the code default. */
  promptModels: Partial<Record<PromptKey, PromptModelPick>>;
  /** Leftover audio-LLM instruction. Live hearing is xAI + Apple and does not send this. */
  hearingInstruction: string;
  /** Fixed words sent to xAI as keyterm. Recent dialogue terms are added on top. */
  sttKeyterms: string[];
  /** Active portrait rows kept in the reply. 4–40, default 12. Relationship stage is extra. */
  portraitActiveMax: number;
  /** Days without corroboration before an active portrait row goes stale. 3–90, default 14. */
  portraitStaleDays: number;
  /** Content words a retrieved note must share with this turn. 1–6, default 1. Filler words do not count. */
  retrieveMinTerms: number;
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
  /** Which sibling reply stays in the thread. Other replies to the same user message are pages. */
  activeReply?: string;
  predictedTags?: AcousticTags;
  hearingGold?: "unconfirmed" | "confirmed";
  hearingTiming?: {
    hearMs?: number;
    grokMs?: number;
    ttsMs?: number;
    ttftMs?: number;
    engine?: string;
  };
  /** What this voice turn actually injected. Session-only debug caption. */
  injectLine?: string;
  /** Kept the clip and skipped the reply because it was not human voice. Tap to ask for one. */
  nightNoise?: boolean;
  interrupted?: boolean;
  talkTrace?: {
    status?: number | null;
    finishReason?: string | null;
    ms?: number;
    chars?: number;
    ttftMs?: number;
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
  voiceModel: DEFAULT_VOICE_MODEL,
  voiceEffort: DEFAULT_VOICE_EFFORT,
  silenceMs: SILENCE_MS,
  injectMind: true,
  injectMemories: true,
  injectLongterm: true,
  historyWindow: HISTORY_WINDOW,
  nightMode: true,
  nightVoicedMin: NIGHT_VOICED_MIN,
  nightMinMs: NIGHT_MIN_MS,
  hearingSense: DEFAULT_HEARING_SENSE,
  promptModels: {},
  hearingInstruction: "",
  sttKeyterms: lockSttKeyterms(undefined),
  portraitActiveMax: PORTRAIT_ACTIVE_MAX,
  portraitStaleDays: PORTRAIT_STALE_DAYS,
  retrieveMinTerms: RETRIEVE_MIN_TERMS,
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
  voiceChat?: string;
  voiceModel?: string;
  voiceEffort?: string | null;
  silenceMs?: number;
  injectMind?: boolean;
  injectMemories?: boolean;
  injectLongterm?: boolean;
  historyWindow?: number;
  nightMode?: boolean;
  nightVoicedMin?: number;
  nightMinMs?: number;
  hearingSense?: unknown;
  promptModels?: unknown;
  hearingInstruction?: unknown;
  sttKeyterms?: unknown;
  portraitActiveMax?: number;
  portraitStaleDays?: number;
  retrieveMinTerms?: number;
};

export function lockedProfile(input?: unknown): Profile {
  const raw = (input && typeof input === "object" ? input : {}) as LooseProfile;
  const hearingSense = lockHearingSense(raw.hearingSense, {
    endWaitMs: raw.silenceMs,
    voicedMin: raw.nightVoicedMin,
    noiseMinMs: raw.nightMinMs,
  });
  return {
    systemPrompt: pickSystemPrompt(raw).slice(0, 16_000),
    muted: Boolean(raw.muted),
    voiceSpeed: pickVoiceSpeed(raw),
    autoRemember: raw.autoRemember !== false,
    memoryCursor: typeof raw.memoryCursor === "string" ? raw.memoryCursor : "",
    hearingProvider: DEFAULT_HEARING_PROVIDER,
    debugHearing: raw.debugHearing !== false,
    captureAudio: raw.debugHearing !== false,
    hearingNbest: Boolean(raw.hearingNbest),
    voiceModel: pickVoiceModel(raw),
    voiceEffort: pickVoiceEffort(raw),
    silenceMs: hearingSense.endWaitMs,
    injectMind: raw.injectMind !== false,
    injectMemories: raw.injectMemories !== false,
    injectLongterm: raw.injectLongterm !== false,
    historyWindow: clampHistoryWindow(raw.historyWindow),
    nightMode: raw.nightMode !== false,
    nightVoicedMin: hearingSense.voicedMin,
    nightMinMs: hearingSense.noiseMinMs,
    hearingSense,
    promptModels: lockPromptModels(raw.promptModels),
    hearingInstruction: lockHearingInstruction(raw.hearingInstruction),
    sttKeyterms: lockSttKeyterms(raw.sttKeyterms),
    portraitActiveMax: clampPortraitActiveMax(raw.portraitActiveMax),
    portraitStaleDays: clampPortraitStaleDays(raw.portraitStaleDays),
    retrieveMinTerms: clampRetrieveMinTerms(raw.retrieveMinTerms),
  };
}

export type VoiceInjectFlags = {
  memories: boolean;
  longterm: boolean;
  history: number;
};

export function voiceInjectFromProfile(profile: {
  injectMemories?: boolean;
  injectLongterm?: boolean;
  historyWindow?: number;
}): VoiceInjectFlags {
  return {
    memories: profile.injectMemories !== false,
    longterm: profile.injectLongterm !== false,
    history: clampHistoryWindow(profile.historyWindow),
  };
}

export function formatVoiceInjectLine(flags: VoiceInjectFlags): string {
  return `记忆：${flags.memories ? "开" : "关"} · 长期：${flags.longterm ? "开" : "关"} · 历史：${flags.history}`;
}

export function parseVoiceInjectLine(note: string | null | undefined): string | null {
  const found = (note ?? "").match(/记忆：[开关] · 长期：[开关] · 历史：\d{1,2}/);
  return found?.[0] ?? null;
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

function pickVoiceModel(raw: LooseProfile): string {
  if (typeof raw.voiceModel === "string" && raw.voiceModel.trim()) return raw.voiceModel.trim().slice(0, 80);
  if (raw.voiceChat === "4.20") return "grok-4.20-0309-non-reasoning";
  if (raw.voiceChat === "4.3-medium" || raw.voiceChat === "4.3-low") return "grok-4.3";
  return DEFAULT_VOICE_MODEL;
}

function pickVoiceEffort(raw: LooseProfile): VoiceEffort {
  if (isVoiceEffort(raw.voiceEffort)) return raw.voiceEffort;
  if (raw.voiceEffort === null) return null;
  if (raw.voiceChat === "4.20") return null;
  if (raw.voiceChat === "4.3-medium") return "medium";
  if (typeof raw.voiceModel === "string" && /non-reasoning/i.test(raw.voiceModel) && !isVoiceEffort(raw.voiceEffort)) {
    return null;
  }
  return DEFAULT_VOICE_EFFORT;
}

function lockHearingInstruction(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.replace(/\r\n/g, "\n").trim().slice(0, 8000);
  if (!text || text === HEARING_INSTRUCTION.trim()) return "";
  return text;
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

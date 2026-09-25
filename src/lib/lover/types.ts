import { DEFAULT_HEARING_PROVIDER, type HearingProviderId, lockSttKeyterms } from "./hearing/config.ts";
import { HEARING_INSTRUCTION } from "./hearing/instruction.ts";
import type { AcousticTags } from "./hearing/tags.ts";
import { clampNightMinMs, clampNightVoicedRatio, NIGHT_MIN_MS, NIGHT_VOICED_MIN } from "./hearing/night-voice.ts";
import { DEFAULT_HEARING_SENSE, lockHearingSense, type HearingSense } from "./hearing/sense.ts";
import { SILENCE_MS } from "./vad.ts";
import { clampHistoryWindow, clampPortraitActiveMax, clampPortraitStaleDays, clampRetrieveMinTerms, clampDossierMaxChars, clampGlowHalfLifeDays, HISTORY_WINDOW, PORTRAIT_ACTIVE_MAX, PORTRAIT_STALE_DAYS, RETRIEVE_MIN_TERMS } from "./brain/config.ts";
import { lockPromptModels, type PromptModelPick } from "./brain/prompts/models.ts";
import type { PromptKey } from "./brain/prompts/catalog.ts";

export { clampHistoryWindow, clampNightMinMs, clampNightVoicedRatio, clampPortraitActiveMax, clampPortraitStaleDays, clampRetrieveMinTerms, clampDossierMaxChars };
export type { HearingSense };

export type VoiceId = "eve";
export type SessionStatus = "idle" | "recording" | "thinking" | "speaking" | "error";
export type MessageKind = "say" | "steer" | "setting" | "unheard" | "proactive" | "system_notice";
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
  /** iOS only. When on, a phone call uses CallKit so it survives background and the lock screen. */
  callKitBackground: boolean;
  /** Dossier character cap. 2000–8000, default 4000. */
  dossierMaxChars: number;
  /** Fixed life, separate from the system prompt. Empty omits the identity line. */
  identity: string;
  /** One sentence of ordinary hours. Written when the busy table is generated. */
  rhythm: string;
  /** Glow half-life in days. 0.5–7, default 2. */
  glowHalfLifeDays: number;
  /** Monthly diary. Off until Rosie turns it on. Manual reports still run. */
  diaryEnabled: boolean;
  /** Shown to him only while the previous turn was an intimate scene and still fresh. */
  intimateNotes: string;
  /** Rosie's story line. Only the inner mind and the memory editor read it; the reply never does. */
  storyline: string;
  /** Run the inner mind (reflect) and memory editor. Off → reply uses persona + context only. */
  brainOn: boolean;
  /** 戏 = voiceModel + systemPrompt. 现实 = realModel + realPrompt (empty → systemPrompt). Rosie flips it by hand. */
  mode: "play" | "real";
  realModel: string;
  realEffort: VoiceEffort;
  realPrompt: string;
  /** Where the persona text sits: system prompt, or the first user message. */
  personaPlacement: "system" | "first_user";
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

/** Used only when nothing is saved. Not a character. */
export const NEUTRAL_PERSONA = "你是清然。";

/** Kept for callers that still import the old name. Empty profiles stay empty. */
export const DEFAULT_SYSTEM_PROMPT = NEUTRAL_PERSONA;

export const DEFAULT_PROFILE: Profile = {
  systemPrompt: "",
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
  callKitBackground: false,
  dossierMaxChars: 4000,
  identity: "",
  rhythm: "",
  glowHalfLifeDays: 2,
  diaryEnabled: false,
  intimateNotes: "",
  storyline: "",
  brainOn: true,
  mode: "play",
  realModel: "grok-4.7",
  realEffort: "low",
  realPrompt: "",
  personaPlacement: "system",
};

type LooseProfile = Partial<Profile> & {
  promptOverride?: string;
  promptFrame?: string;
  world?: string;
  persona?: string;
  rules?: string;
  friends?: string;
  story?: string;
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
  callKitBackground?: boolean;
  dossierMaxChars?: number;
  identity?: string;
  rhythm?: string;
  glowHalfLifeDays?: number;
  diaryEnabled?: boolean;
  intimateNotes?: string;
  storyline?: string;
  brainOn?: boolean;
  mode?: string;
  realModel?: string;
  realEffort?: unknown;
  realPrompt?: string;
  personaPlacement?: string;
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
    callKitBackground: raw.callKitBackground === true,
    dossierMaxChars: clampDossierMaxChars(raw.dossierMaxChars),
    identity: typeof raw.identity === "string" ? raw.identity.slice(0, 2000) : "",
    rhythm: typeof raw.rhythm === "string" ? raw.rhythm.slice(0, 500) : "",
    glowHalfLifeDays: clampGlowHalfLifeDays(raw.glowHalfLifeDays),
    diaryEnabled: raw.diaryEnabled === true,
    intimateNotes: typeof raw.intimateNotes === "string" ? raw.intimateNotes.slice(0, 8000) : "",
    storyline: typeof raw.storyline === "string" ? raw.storyline.slice(0, 20000) : "",
    brainOn: raw.brainOn !== false,
    mode: raw.mode === "real" ? "real" : "play",
    realModel: typeof raw.realModel === "string" && raw.realModel.trim() ? raw.realModel.trim().slice(0, 80) : "grok-4.7",
    realEffort: raw.realEffort === null ? null : isVoiceEffort(raw.realEffort) ? raw.realEffort : "low",
    realPrompt: typeof raw.realPrompt === "string" ? raw.realPrompt.slice(0, 16_000) : "",
    personaPlacement: raw.personaPlacement === "first_user" ? "first_user" : "system",
  };
}

export type VoiceInjectFlags = {
  moment: boolean;
  dossier: boolean;
  history: number;
};

export function voiceInjectFromProfile(profile: {
  injectMind?: boolean;
  injectLongterm?: boolean;
  historyWindow?: number;
}): VoiceInjectFlags {
  return {
    moment: profile.injectMind !== false,
    dossier: profile.injectLongterm !== false,
    history: clampHistoryWindow(profile.historyWindow),
  };
}

export function formatVoiceInjectLine(flags: VoiceInjectFlags): string {
  return `我此刻：${flags.moment ? "开" : "关"} · 我记得的：${flags.dossier ? "开" : "关"} · 历史：${flags.history}`;
}

export function parseVoiceInjectLine(note: string | null | undefined): string | null {
  const text = note ?? "";
  const next = text.match(/我此刻：[开关] · 我记得的：[开关] · 历史：\d{1,2}/);
  if (next) return next[0];
  const old = text.match(/记忆：[开关] · 长期：[开关] · 历史：\d{1,2}/);
  return old?.[0] ?? null;
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
  return "";
}

/** Persona actually stored on a profile. Empty means none — callers must not invent one. */
export function storedSystemPrompt(input: unknown): string {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return "";
    try {
      return storedSystemPrompt(JSON.parse(trimmed) as unknown);
    } catch {
      return "";
    }
  }
  if (!input || typeof input !== "object") return "";
  return pickSystemPrompt(input as LooseProfile);
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
  return chunks.join("\n\n");
}

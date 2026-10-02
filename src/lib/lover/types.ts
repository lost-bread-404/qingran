import { DEFAULT_HEARING_PROVIDER, type HearingProviderId, lockSttKeyterms } from "./hearing/config.ts";
import type { AcousticTags } from "./hearing/tags.ts";
import { clampNightMinMs, clampNightVoicedRatio, NIGHT_MIN_MS, NIGHT_VOICED_MIN } from "./hearing/night-voice.ts";
import { DEFAULT_HEARING_SENSE, lockHearingSense, type HearingSense } from "./hearing/sense.ts";
import { SILENCE_MS } from "./vad.ts";
import { clampHistoryWindow, clampDossierMaxChars, HISTORY_WINDOW } from "./brain/config.ts";
import { lockPromptModels, type PromptModelPick } from "./brain/prompts/models.ts";
import type { PromptKey } from "./brain/prompts/catalog.ts";

export { clampHistoryWindow, clampNightMinMs, clampNightVoicedRatio, clampDossierMaxChars };
export type { HearingSense };

export type VoiceId = "eve";
export type SessionStatus = "idle" | "recording" | "thinking" | "speaking" | "error";
export type MessageKind = "say" | "unheard" | "proactive" | "system_notice";
export type VoiceEffort = "low" | "medium" | "high" | null;

export const DEFAULT_VOICE_MODEL = "grok-4.20-0309-non-reasoning";
export const DEFAULT_VOICE_EFFORT: VoiceEffort = "low";
export const VOICE_EFFORT_OPTIONS = ["low", "medium", "high"] as const;

export function isVoiceEffort(value: unknown): value is Exclude<VoiceEffort, null> {
  return value === "low" || value === "medium" || value === "high";
}

export type Profile = {
  systemPrompt: string;
  muted: boolean;
  voiceSpeed: number;
  memoryCursor: string;
  hearingProvider: HearingProviderId;
  captureAudio: boolean;
  debugHearing: boolean;
  voiceModel: string;
  voiceEffort: VoiceEffort;
  /** Pause that ends a turn, milliseconds. 800–3000, default 1500. */
  silenceMs: number;
  /** 清然和 Rosie 现在 and the moments that come back to him, in the voice prompt. */
  injectLongterm: boolean;
  /** At least this many recent messages in the voice prompt (it gets all of today's talk), and the archive slide-out window. 0–80. */
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
  /** Fixed words sent to xAI as keyterm. Recent dialogue terms are added on top. */
  sttKeyterms: string[];
  /** Cap on 清然和 Rosie 现在. 500–3000, default 1500. */
  dossierMaxChars: number;
  /** Fixed life, separate from the system prompt. Empty omits the identity line. */
  identity: string;
  /** One sentence of ordinary hours. Written when the busy table is generated. */
  rhythm: string;
  /** Monthly diary. Off until Rosie turns it on. Manual reports still run. */
  diaryEnabled: boolean;
  /** 清然's intimate side. Part of the persona the reply reads (personaText), right after it. */
  intimateNotes: string;
  /** The story Rosie wrote of their months before this app. Cut into moments, it is the start of his memory. */
  storyline: string;
  /** Memory, the night pass and proactive messages. Off → reply uses persona + context only. */
  brainOn: boolean;
  /** Where the persona text sits: system prompt, or the first user message. */
  personaPlacement: "system" | "first_user";
  /** With the persona as the first message: his line right after it (a fixed line, no model call). */
  personaAck: string;
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
  /** Photos she sent with this line (ids in qr_photos, shown from /api/photo). */
  images?: string[];
  interrupted?: boolean;
  talkTrace?: {
    status?: number | null;
    finishReason?: string | null;
    ms?: number;
    chars?: number;
    ttftMs?: number;
  };
};

/** Used only when nothing is saved. Not a character. */
export const NEUTRAL_PERSONA = "你是清然。";

export const DEFAULT_PROFILE: Profile = {
  systemPrompt: "",
  muted: false,
  voiceSpeed: 1,
  memoryCursor: "",
  hearingProvider: DEFAULT_HEARING_PROVIDER,
  captureAudio: true,
  debugHearing: true,
  voiceModel: DEFAULT_VOICE_MODEL,
  voiceEffort: DEFAULT_VOICE_EFFORT,
  silenceMs: SILENCE_MS,
  injectLongterm: true,
  historyWindow: HISTORY_WINDOW,
  nightMode: true,
  nightVoicedMin: NIGHT_VOICED_MIN,
  nightMinMs: NIGHT_MIN_MS,
  hearingSense: DEFAULT_HEARING_SENSE,
  promptModels: {},
  sttKeyterms: lockSttKeyterms(undefined),
  dossierMaxChars: 1500,
  identity: "",
  rhythm: "",
  diaryEnabled: false,
  intimateNotes: "",
  storyline: "",
  brainOn: true,
  personaPlacement: "system",
  personaAck: "嗯。",
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
  memoryCursor?: string;
  hearingProvider?: string;
  captureAudio?: boolean;
  debugHearing?: boolean;
  voiceChat?: string;
  voiceModel?: string;
  voiceEffort?: string | null;
  silenceMs?: number;
  injectLongterm?: boolean;
  historyWindow?: number;
  nightMode?: boolean;
  nightVoicedMin?: number;
  nightMinMs?: number;
  hearingSense?: unknown;
  promptModels?: unknown;
  sttKeyterms?: unknown;
  dossierMaxChars?: number;
  identity?: string;
  rhythm?: string;
  diaryEnabled?: boolean;
  intimateNotes?: string;
  storyline?: string;
  brainOn?: boolean;
  personaPlacement?: string;
  personaAck?: string;
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
    memoryCursor: typeof raw.memoryCursor === "string" ? raw.memoryCursor : "",
    hearingProvider: DEFAULT_HEARING_PROVIDER,
    debugHearing: raw.debugHearing !== false,
    captureAudio: raw.debugHearing !== false,
    voiceModel: pickVoiceModel(raw),
    voiceEffort: pickVoiceEffort(raw),
    silenceMs: hearingSense.endWaitMs,
    injectLongterm: raw.injectLongterm !== false,
    historyWindow: clampHistoryWindow(raw.historyWindow),
    nightMode: raw.nightMode !== false,
    nightVoicedMin: hearingSense.voicedMin,
    nightMinMs: hearingSense.noiseMinMs,
    hearingSense,
    promptModels: lockPromptModels(raw.promptModels),
    sttKeyterms: lockSttKeyterms(raw.sttKeyterms),
    dossierMaxChars: clampDossierMaxChars(raw.dossierMaxChars),
    identity: typeof raw.identity === "string" ? raw.identity.slice(0, 2000) : "",
    rhythm: typeof raw.rhythm === "string" ? raw.rhythm.slice(0, 500) : "",
    diaryEnabled: raw.diaryEnabled === true,
    intimateNotes: typeof raw.intimateNotes === "string" ? raw.intimateNotes.slice(0, 8000) : "",
    storyline: typeof raw.storyline === "string" ? raw.storyline.slice(0, 20000) : "",
    brainOn: raw.brainOn !== false,
    personaPlacement: raw.personaPlacement === "first_user" ? "first_user" : "system",
    personaAck: typeof raw.personaAck === "string" && raw.personaAck.trim() ? raw.personaAck.trim().slice(0, 200) : "嗯。",
  };
}

export type VoiceInjectFlags = {
  /** 清然和 Rosie 现在 + the moments that come back to him. */
  memory: boolean;
  /** At least this many recent messages (all of today's talk is given anyway). */
  history: number;
};

export function voiceInjectFromProfile(profile: {
  injectLongterm?: boolean;
  brainOn?: boolean;
  historyWindow?: number;
}): VoiceInjectFlags {
  return {
    memory: profile.injectLongterm !== false && profile.brainOn !== false,
    history: clampHistoryWindow(profile.historyWindow),
  };
}

export function formatVoiceInjectLine(flags: VoiceInjectFlags): string {
  return `回忆：${flags.memory ? "开" : "关"} · 历史：至少 ${flags.history}`;
}

export function parseVoiceInjectLine(note: string | null | undefined): string | null {
  const text = note ?? "";
  return text.match(/回忆：[开关] · 历史：至少 \d{1,2}/)?.[0] ?? null;
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

/**
 * The persona the reply reads: what Rosie wrote about 清然, with his intimate side right after it. Both sit at the top
 * as who he is, like a character card, so the talk itself (read last) decides what the moment is; given near her line
 * instead, the intimate notes read as the task and outweighed what she was saying.
 */
export function personaText(p: { systemPrompt: string; intimateNotes: string }): string {
  const notes = p.intimateNotes.trim();
  return notes ? `${p.systemPrompt.trim()}\n\n清然在床上的样子：\n${notes}` : p.systemPrompt;
}

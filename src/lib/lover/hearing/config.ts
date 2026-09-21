export const HEARING_PROVIDERS = ["xai", "qwen", "gemini", "selfhost"] as const;
export type HearingProviderId = (typeof HEARING_PROVIDERS)[number];

export const DEFAULT_HEARING_PROVIDER: HearingProviderId = "xai";
export const DEFAULT_HEARING_TIMEOUT_MS = 8000;
export const DEFAULT_XAI_VAD_THRESHOLD = 0.3;

export const QWEN_HEARING_MODELS = ["qwen3.5-omni-flash", "qwen3.8-omni-flash"] as const;
export type QwenHearingModel = (typeof QWEN_HEARING_MODELS)[number];
export const DEFAULT_QWEN_HEARING_MODEL: QwenHearingModel = "qwen3.5-omni-flash";

export const LAB_EVAL_ENGINES = [
  "xai",
  "qwen3.5-omni-flash",
  "qwen3.8-omni-flash",
  "gemini",
  "selfhost",
] as const;
export type LabEvalEngine = (typeof LAB_EVAL_ENGINES)[number];

/** xAI STT keyterms. Single-char fillers + names we actually want biased. */
export const STT_KEYTERMS: readonly string[] = [
  "姐姐",
  "清然",
  "小猫",
  "Rosie",
  "嗯",
  "啊",
  "呜",
  "哈",
  "哼",
  "哦",
  "唉",
  "嘛",
  "呀",
  "啦",
  "呢",
  "吧",
  "喵",
  "嗷",
  "嗷呜",
  "喵呜",
  "呜喵",
];

/** Fillers and onomatopoeia that are real speech, including repeats (嗯嗯, 嗷呜嗷呜). */
export const VOCAL_CUES: readonly string[] = [
  "嗯",
  "啊",
  "呜",
  "哈",
  "哼",
  "哦",
  "唉",
  "嘛",
  "呀",
  "啦",
  "呢",
  "吧",
  "喵",
  "嗷",
  "嗷呜",
  "喵呜",
];

export const HEARING = {
  timeoutMs: DEFAULT_HEARING_TIMEOUT_MS,
  xai: {
    id: "xai" as const,
    model: "grok-voice-transcribe-2.0",
    sttUrl: "https://api.x.ai/v1/stt",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
  },
  qwen: {
    id: "qwen" as const,
    model: DEFAULT_QWEN_HEARING_MODEL,
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    inputUsdPerM: 0.065,
    outputUsdPerM: 0.26,
  },
  gemini: {
    id: "gemini" as const,
    model: "gemini-3.8-flash",
    generateUrl:
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    inputUsdPerM: 0.75,
    outputUsdPerM: 3.75,
  },
  selfhost: {
    id: "selfhost" as const,
    model: "Qwen/Qwen2.5-Omni-7B",
    servedName: "qwen2.5-omni-7b",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
  },
} as const;

export function hearingTimeoutMs(): number {
  const raw = Number(process.env.HEARING_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 500) return Math.min(20_000, Math.floor(raw));
  return DEFAULT_HEARING_TIMEOUT_MS;
}

export function xaiVadThreshold(): number {
  const raw = Number(process.env.XAI_VAD_THRESHOLD);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  return DEFAULT_XAI_VAD_THRESHOLD;
}

export function selfhostBaseUrl(): string {
  return (process.env.SELFHOST_BASE_URL || "").replace(/\/+$/, "");
}

export function selfhostApiKey(): string {
  return process.env.SELFHOST_API_KEY || "qingran";
}

export function selfhostModel(): string {
  return process.env.SELFHOST_MODEL || HEARING.selfhost.servedName;
}

export function qwenHearingModel(): string {
  const raw = process.env.QWEN_HEARING_MODEL?.trim();
  return raw || DEFAULT_QWEN_HEARING_MODEL;
}

export function isQwenHearingModel(value: unknown): value is QwenHearingModel {
  return typeof value === "string" && (QWEN_HEARING_MODELS as readonly string[]).includes(value);
}

export function isLabEvalEngine(value: unknown): value is LabEvalEngine {
  return typeof value === "string" && (LAB_EVAL_ENGINES as readonly string[]).includes(value);
}

export function qwenReasoningEffort(model: string): "none" | undefined {
  return /qwen3\.8-omni/i.test(model) ? "none" : undefined;
}

export function labEngineLabel(id: string): string {
  if (id === "xai") return "xAI";
  if (id === "qwen") return "Qwen";
  if (id === "qwen3.5-omni-flash") return "Qwen 3.5";
  if (id === "qwen3.8-omni-flash") return "Qwen 3.8";
  if (id === "gemini") return "Gemini";
  if (id === "selfhost") return "自建";
  return id;
}

export function isHearingProvider(value: unknown): value is HearingProviderId {
  return typeof value === "string" && (HEARING_PROVIDERS as readonly string[]).includes(value);
}

export function estimateCostUsd(
  provider: HearingProviderId,
  tokensIn: number,
  tokensOut: number,
): number {
  const row = HEARING[provider];
  return (tokensIn / 1_000_000) * row.inputUsdPerM + (tokensOut / 1_000_000) * row.outputUsdPerM;
}

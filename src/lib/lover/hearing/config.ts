/** xAI only. Audio LLMs (Qwen, Gemini, self-hosted) refused intimate audio and were dropped (requirements 第 7 节). */
export const HEARING_PROVIDERS = ["xai"] as const;
export type HearingProviderId = (typeof HEARING_PROVIDERS)[number];

export const DEFAULT_HEARING_PROVIDER: HearingProviderId = "xai";
export const DEFAULT_XAI_VAD_THRESHOLD = 0.3;

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

/** User list, or the built-in list when a profile has never set one. Empty is allowed. */
export function lockSttKeyterms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...STT_KEYTERMS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const next = item.trim().slice(0, 50);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= 100) break;
  }
  return out;
}

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
  xai: {
    id: "xai" as const,
    model: "grok-voice-transcribe-2.0",
    sttUrl: "https://api.x.ai/v1/stt",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
  },
} as const;

export function xaiVadThreshold(): number {
  const raw = Number(process.env.XAI_VAD_THRESHOLD);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  return DEFAULT_XAI_VAD_THRESHOLD;
}


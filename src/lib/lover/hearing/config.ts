export const HEARING_PROVIDERS = ["xai", "qwen", "gemini", "selfhost"] as const;
export type HearingProviderId = (typeof HEARING_PROVIDERS)[number];

export const DEFAULT_HEARING_PROVIDER: HearingProviderId = "xai";
export const DEFAULT_HEARING_TIMEOUT_MS = 4000;

export const HEARING = {
  timeoutMs: DEFAULT_HEARING_TIMEOUT_MS,
  xai: {
    id: "xai" as const,
    model: "grok-stt",
    sttUrl: "https://api.x.ai/v1/stt",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
  },
  qwen: {
    id: "qwen" as const,
    model: "qwen3.5-omni-flash",
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

export const SCRIPTED_CATEGORIES = [
  { id: "en", label: "嗯", quota: 12 },
  { id: "ah", label: "啊", quota: 12 },
  { id: "breathy", label: "气声", quota: 10 },
  { id: "coy", label: "撒娇", quota: 12 },
  { id: "murmur", label: "呢喃", quota: 10 },
  { id: "laugh", label: "笑", quota: 8 },
  { id: "cry", label: "哭腔", quota: 8 },
  { id: "sigh", label: "叹气", quota: 8 },
  { id: "sleepy", label: "困倦", quota: 8 },
  { id: "noise", label: "纯噪音", quota: 10 },
  { id: "sentence", label: "带语气的句子", quota: 16 },
] as const;

export type ScriptedCategoryId = (typeof SCRIPTED_CATEGORIES)[number]["id"];

export function hearingTimeoutMs(): number {
  const raw = Number(process.env.HEARING_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 500) return Math.min(20_000, Math.floor(raw));
  return DEFAULT_HEARING_TIMEOUT_MS;
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

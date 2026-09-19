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
  {
    id: "en",
    label: "嗯",
    quota: 12,
    hint: "各种「嗯」，比如应声的、撒娇拖长的、疑问上扬的。",
    example: "嗯～ / 嗯？ / 嗯…",
  },
  {
    id: "ah",
    label: "啊",
    quota: 12,
    hint: "各种「啊」，比如应声的、撒娇拖长的、疑问上扬的。",
    example: "啊～ / 啊？ / 啊…",
  },
  {
    id: "breathy",
    label: "气声",
    quota: 10,
    hint: "声带不完全闭合、气多声少，像贴着耳朵说悄悄话，但还带一点声调。",
    example: "困的时候贴着枕头轻声说「嗯……好」。",
  },
  {
    id: "coy",
    label: "撒娇",
    quota: 12,
    hint: "拖长音、音调上扬、语气软。",
    example: "不要嘛～",
  },
  {
    id: "murmur",
    label: "呢喃",
    quota: 10,
    hint: "音量很低、嘴几乎不张、吐字含糊，但有声音。",
    example: "半睡着嘟囔「再睡五分钟」。",
  },
  {
    id: "laugh",
    label: "笑",
    quota: 8,
    hint: "轻笑、憋笑、笑出声都可以。",
    example: "噗嗤一声，或忍不住笑出声。",
  },
  {
    id: "cry",
    label: "哭腔",
    quota: 8,
    hint: "带哭腔说话，或者抽泣。",
    example: "带着鼻音说「我没有哭」。",
  },
  {
    id: "sigh",
    label: "叹气",
    quota: 8,
    hint: "一次长呼气，可以带「唉」或「哈」。",
    example: "唉—— / 哈…",
  },
  {
    id: "sleepy",
    label: "困倦",
    quota: 8,
    hint: "困的时候说的话，慢、含糊、带哈欠。",
    example: "哈欠着说「再睡一会儿」。",
  },
  {
    id: "noise",
    label: "纯噪音",
    quota: 10,
    hint: "不说话，只录环境声、衣服摩擦、键盘、碰到麦克风。这一类的正确识别结果就是空。",
    example: "键盘、衣料摩擦、碰麦，不要出声。",
  },
  {
    id: "sentence",
    label: "带语气的句子",
    quota: 16,
    hint: "一句完整的话，带明显的情绪。",
    example: "今天好累啊，真不想动。",
  },
  {
    id: "codeswitch",
    label: "中英夹杂",
    quota: 12,
    hint: "中文句子里夹着英文词。",
    example: "这个 deadline 好 annoying。",
  },
  {
    id: "homophone",
    label: "同音词",
    quota: 10,
    hint: "容易听错的词，比如专有名词。",
    example: "清然 / 青然",
  },
] as const;

export type ScriptedCategoryId = (typeof SCRIPTED_CATEGORIES)[number]["id"];

export const EXPECTED_HEARING_MIGRATIONS = [
  "0002_qingran.sql",
  "0003_hearing.sql",
  "0004_auth_attempts.sql",
  "0005_hearing_fallback_raw.sql",
  "0006_hearing_eval.sql",
] as const;

export const EXPECTED_CLIP_COLUMNS = [
  "blob_error",
  "storage_backend",
  "gold_source",
  "stt_text",
  "gold_tier",
  "utterance_emotion",
  "mode",
  "audio_route",
  "turn_id",
  "disagreement",
] as const;

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

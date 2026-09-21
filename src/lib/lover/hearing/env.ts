import { HEARING_PROVIDERS, type HearingProviderId } from "./config.ts";

export const HEARING_ENV_KEYS = [
  "XAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "GEMINI_API_KEY",
  "SELFHOST_BASE_URL",
  "BLOB_READ_WRITE_TOKEN",
  "DATABASE_URL",
] as const;

export type HearingEnvKey = (typeof HEARING_ENV_KEYS)[number];

export const PROVIDER_ENV: Record<HearingProviderId, HearingEnvKey> = {
  xai: "XAI_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  gemini: "GEMINI_API_KEY",
  selfhost: "SELFHOST_BASE_URL",
};

export function envPresence(): Record<HearingEnvKey, boolean> {
  const out = {} as Record<HearingEnvKey, boolean>;
  for (const key of HEARING_ENV_KEYS) {
    out[key] = Boolean(typeof process !== "undefined" && process.env[key]?.trim());
  }
  return out;
}

export function configuredProviders(presence = envPresence()): Record<HearingProviderId, boolean> {
  const out = {} as Record<HearingProviderId, boolean>;
  for (const id of HEARING_PROVIDERS) out[id] = presence[PROVIDER_ENV[id]];
  return out;
}

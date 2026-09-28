import { type HearingAdapterOutcome } from "./select.ts";

export type AdapterFail = Extract<HearingAdapterOutcome, { ok: false }>;
export type AdapterOk = Extract<HearingAdapterOutcome, { ok: true }>;
export type AdapterOutcome = HearingAdapterOutcome;

export type HearingCallOpts = {
  context?: string;
};

export function clipFallbackRaw(raw?: string | null): string | null {
  if (!raw) return null;
  return raw.slice(0, 2000);
}


import { HEARING_USER_LINE } from "./instruction.ts";
import { type HearingAdapterOutcome } from "./select.ts";

export type AdapterFail = Extract<HearingAdapterOutcome, { ok: false }>;
export type AdapterOk = Extract<HearingAdapterOutcome, { ok: true }>;
export type AdapterOutcome = HearingAdapterOutcome;

export type HearingCallOpts = {
  context?: string;
  nbest?: boolean;
  /** Replaces the built-in system instruction. xAI and Apple never receive this. */
  instruction?: string;
};

export const HEARING_USER_PROMPT = HEARING_USER_LINE;

export function clipFallbackRaw(raw?: string | null): string | null {
  if (!raw) return null;
  return raw.slice(0, 2000);
}


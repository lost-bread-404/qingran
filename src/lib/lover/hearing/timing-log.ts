import { appendBrainLog } from "../brain/store.ts";
import { formatHearingLogNote, type HearingTiming } from "./timing-format.ts";

export {
  formatHearingLogNote,
  formatHearingTimingSummary,
  formatMs,
  parseHearingTimingLine,
  type HearingTiming,
  type ParsedHearingTiming,
} from "./timing-format.ts";

export async function recordHearingTimingLog(
  input: HearingTiming & {
    ok: boolean;
    raw?: string | null;
    error?: string | null;
  },
): Promise<void> {
  const note = formatHearingLogNote(input);
  const parts = [input.silenceMs, input.uploadMs, input.sttMs, input.correctMs];
  const ms = parts.reduce<number>((sum, n) => sum + (n != null && Number.isFinite(n) ? Math.max(0, n) : 0), 0);
  await appendBrainLog({
    step: "hearing",
    ok: input.ok,
    ms,
    raw: (input.raw ?? note).slice(0, 1000),
    note,
    route: "hear",
    model: input.engineUsed ?? input.engineRequested ?? null,
    error: input.error ?? null,
  });
}

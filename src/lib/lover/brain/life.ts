/** Pure rules for glow, busy wording, and when Qingran wakes up. No database. */

export const GLOW_HALF_LIFE_MS = 2 * 24 * 60 * 60 * 1000;
export const GLOW_HALF_LIFE_MIN_MS = 0.5 * 24 * 60 * 60 * 1000;
export const GLOW_HALF_LIFE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** Calm, medium busy, no longing: about once every 2.5 days. */
export const BASE_RANDOM_PER_HOUR = 1 / 60;
export const REACH_MIN_MS = 10 * 60 * 1000;
export const REACH_MAX_MS = 72 * 60 * 60 * 1000;
export const REACH_LLM_DAY_MAX = 48;
export const REACH_SENT_DAY_MAX = 30;
export const CHAT_QUIET_MS = 30 * 60 * 1000;
export const REACH_RETRY_MS = 15 * 60 * 1000;

const SILENCE_MINUTES = [10, 20, 40, 80, 160, 320];

export function busyWord(busy: number): string {
  if (busy < 0.3) return "很闲";
  if (busy < 0.6) return "正常";
  if (busy < 0.85) return "忙";
  return "非常忙";
}

export function glowNow(glow: number, glowAt: number, nowMs: number, halfLifeMs = GLOW_HALF_LIFE_MS): number {
  if (!glow || !glowAt || nowMs <= glowAt) return glow;
  return glow * 0.5 ** ((nowMs - glowAt) / halfLifeMs);
}

/** Null means 平常: omit the line. */
export function glowWord(glow: number): string | null {
  if (glow <= -25) return "很受伤";
  if (glow <= -8) return "有点低落";
  if (glow < 8) return null;
  if (glow < 25) return "很开心";
  return "特别兴奋";
}

export function applyGlowDelta(
  glow: number,
  glowAt: number,
  nowMs: number,
  delta: number,
  halfLifeMs = GLOW_HALF_LIFE_MS,
): { glow: number; glowAt: number; event: boolean } {
  const current = glowNow(glow, glowAt, nowMs, halfLifeMs);
  if (!delta) return { glow: current, glowAt, event: false };
  const next = Math.max(-60, Math.min(60, current + delta));
  return { glow: next, glowAt: nowMs, event: true };
}

export function clampReachMs(ms: number): number {
  if (!Number.isFinite(ms)) return REACH_MIN_MS;
  return Math.max(REACH_MIN_MS, Math.min(REACH_MAX_MS, ms));
}

export function clampInHours(hours: number): number {
  return clampReachMs(hours * 3_600_000) / 3_600_000;
}

export function randomWakeProbability(input: {
  glow: number;
  busy: number;
  longings: number;
  basePerHour?: number;
}): number {
  const base = input.basePerHour ?? BASE_RANDOM_PER_HOUR;
  const lambda = base * (1 + input.glow / 40) * (1.4 - input.busy) * (1 + 0.25 * input.longings);
  return 1 - Math.exp(-Math.max(0, lambda) / 6);
}

/**
 * N is how many proactive messages were sent after Rosie's last line, starting at 1.
 * The spec writes `[min(N, 5)]` on a 6-long list. Treating that as a 0-based index
 * would skip the 10-minute step, so N=1 uses the first step.
 */
export function silenceFloorMs(unanswered: number): number {
  const n = Math.max(1, Math.floor(unanswered));
  const index = Math.min(n, SILENCE_MINUTES.length) - 1;
  return SILENCE_MINUTES[index]! * 60_000;
}

export function identityBlock(identity: string): string {
  const text = identity.trim();
  return text ? `【我的身份】\n${text}` : "";
}

export function busyContextLine(input: {
  label: string;
  busy: number;
  reason: string;
  rhythm: string;
}): string {
  const label = input.label.trim();
  const reason = input.reason.trim();
  const rhythm = input.rhythm.trim();
  if (!label && !rhythm) return "";
  const word = busyWord(input.busy);
  const named = label
    ? `我这段时间：${label}（${word}${reason ? `，${reason}` : ""}）。`
    : "";
  return `（只用于决定下一次什么时候找她）${named}${rhythm}`;
}

export type BusyPeriod = {
  id: string;
  fromDay: string;
  toDay: string;
  busy: number;
  label: string;
  reason: string;
};

export function periodOnDay(periods: BusyPeriod[], day: string): BusyPeriod | null {
  const hits = periods.filter((row) => row.fromDay <= day && day <= row.toDay);
  return hits[0] ?? null;
}

export function periodsOverlap(periods: Array<{ fromDay: string; toDay: string }>): boolean {
  const sorted = [...periods].sort((a, b) => (a.fromDay < b.fromDay ? -1 : a.fromDay > b.fromDay ? 1 : 0));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.fromDay <= sorted[i - 1]!.toDay) return true;
  }
  return false;
}

export type WakeSkip = "disabled" | "chatting" | "not_due" | "breaker" | "locked";

export type WakeDecision =
  | { action: "return"; reason: WakeSkip; log: boolean; nextAt?: number }
  | { action: "call"; trigger: "planned" | "random" | "manual" };

/** Code-only gate. The LLM runs only when this says call. */
export function decideWake(input: {
  enabled: boolean;
  chatting: boolean;
  nextAt: number | null;
  now: number;
  roll: number;
  probability: number;
  llmToday: number;
  sentToday: number;
  tomorrowMorning: number;
  manual?: boolean;
  llmMax?: number;
  sentMax?: number;
}): WakeDecision {
  if (!input.enabled) return { action: "return", reason: "disabled", log: true };
  if (input.manual) {
    if (input.llmToday >= (input.llmMax ?? REACH_LLM_DAY_MAX) || input.sentToday >= (input.sentMax ?? REACH_SENT_DAY_MAX)) {
      return { action: "return", reason: "breaker", log: true, nextAt: input.tomorrowMorning };
    }
    return { action: "call", trigger: "manual" };
  }
  if (input.chatting) return { action: "return", reason: "chatting", log: false };
  const llmMax = input.llmMax ?? REACH_LLM_DAY_MAX;
  const sentMax = input.sentMax ?? REACH_SENT_DAY_MAX;
  let trigger: "planned" | "random" | null = null;
  if (input.nextAt != null && input.now >= input.nextAt) trigger = "planned";
  else if (input.nextAt == null && input.roll < input.probability) trigger = "random";
  if (!trigger) return { action: "return", reason: "not_due", log: false };
  if (input.llmToday >= llmMax || input.sentToday >= sentMax) {
    return { action: "return", reason: "breaker", log: true, nextAt: input.tomorrowMorning };
  }
  return { action: "call", trigger };
}

/** When the model names a time during silence, it cannot be sooner than the floor. */
export function clampNextReachAt(nowMs: number, inHours: number | null, unanswered: number): number | null {
  if (inHours == null) return null;
  let at = nowMs + clampReachMs(inHours * 3_600_000);
  if (unanswered > 0) at = Math.max(at, nowMs + silenceFloorMs(unanswered));
  return at;
}

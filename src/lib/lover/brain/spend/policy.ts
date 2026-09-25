import { localDay, shiftDay, zonedParts } from "../time.ts";

export type SpendRoute =
  | "voice"
  | "tts"
  | "stt"
  | "reflect"
  | "archive"
  | "dusk"
  | "portrait"
  | "assign"
  | "ask"
  | "synth"
  | "backfill"
  | "report"
  | "judge"
  | "editor"
  | "busy"
  | "reach"
  | "replay";

export type SpendLevel = "ok" | "soft" | "hard" | "breaker";
export type SpendScope = "day" | "month";

export type SpendLimits = {
  daySoft: number;
  dayHard: number;
  dayBreaker: number;
  monthSoft: number;
  monthHard: number;
  monthBreaker: number;
};

export type SpendDecision = {
  allow: boolean;
  level: SpendLevel;
  scope: SpendScope | null;
  resumeAt: number | null;
};

export type SpendOverrides = { day?: boolean; month?: boolean };

const RANK: Record<SpendLevel, number> = { ok: 0, soft: 1, hard: 2, breaker: 3 };

const P0 = new Set<SpendRoute>(["voice", "tts", "stt", "replay"]);
const P1 = new Set<SpendRoute>(["reflect", "reach"]);
const P2 = new Set<SpendRoute>(["archive", "dusk", "portrait", "assign", "ask", "editor", "busy"]);

export function routePriority(route: string): 0 | 1 | 2 | 3 {
  const r = route as SpendRoute;
  if (P0.has(r)) return 0;
  if (P1.has(r) || route === "wake") return 1;
  if (P2.has(r)) return 2;
  return 3;
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function defaultSpendLimits(): SpendLimits {
  return {
    daySoft: envNum("QR_SPEND_DAY_SOFT", 15),
    dayHard: envNum("QR_SPEND_DAY_HARD", 30),
    dayBreaker: envNum("QR_SPEND_DAY_BREAKER", 50),
    monthSoft: envNum("QR_SPEND_MONTH_SOFT", 100),
    monthHard: envNum("QR_SPEND_MONTH_HARD", 150),
    monthBreaker: envNum("QR_SPEND_MONTH_BREAKER", 200),
  };
}

export function validateSpendLimits(l: SpendLimits): string | null {
  const vals = [l.daySoft, l.dayHard, l.dayBreaker, l.monthSoft, l.monthHard, l.monthBreaker];
  if (vals.some((n) => !Number.isFinite(n) || n <= 0)) return "限额必须是正数";
  if (!(l.daySoft < l.dayHard && l.dayHard < l.dayBreaker)) return "每日限额必须满足 软 < 硬 < 熔断";
  if (!(l.monthSoft < l.monthHard && l.monthHard < l.monthBreaker)) return "每月限额必须满足 软 < 硬 < 熔断";
  return null;
}

export function levelForUsd(usd: number, soft: number, hard: number, breaker: number, override: boolean): SpendLevel {
  if (usd >= breaker) return override ? "hard" : "breaker";
  if (usd >= hard) return "hard";
  if (usd >= soft) return "soft";
  return "ok";
}

function pausedBy(level: SpendLevel, priority: 0 | 1 | 2 | 3): boolean {
  if (level === "ok") return false;
  if (level === "soft") return priority >= 3;
  if (level === "hard") return priority >= 2;
  return true;
}

/** Wall time `YYYY-MM-DD HH:MM` in `timeZone` → epoch ms. */
export function zonedWallMs(day: string, hour: number, minute: number, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number);
  let guess = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hour, minute, 0);
  for (let i = 0; i < 8; i++) {
    const p = zonedParts(guess, timeZone);
    const target = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hour, minute);
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const delta = target - actual;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

export function resumeAtMs(scope: SpendScope, nowMs: number, timeZone: string): number {
  const day = localDay(nowMs, timeZone);
  if (scope === "day") return zonedWallMs(shiftDay(day, 1), 4, 30, timeZone);
  const [y, m] = day.slice(0, 7).split("-").map(Number);
  const ny = m === 12 ? (y ?? 2026) + 1 : (y ?? 2026);
  const nm = m === 12 ? 1 : (m ?? 1) + 1;
  const first = `${ny}-${String(nm).padStart(2, "0")}-01`;
  return zonedWallMs(first, 4, 30, timeZone);
}

export function spendDecision(
  route: string,
  dayUsd: number,
  monthUsd: number,
  limits: SpendLimits,
  overrides: SpendOverrides,
  nowMs: number,
  timeZone: string,
): SpendDecision {
  const dayLevel = levelForUsd(dayUsd, limits.daySoft, limits.dayHard, limits.dayBreaker, Boolean(overrides.day));
  const monthLevel = levelForUsd(
    monthUsd,
    limits.monthSoft,
    limits.monthHard,
    limits.monthBreaker,
    Boolean(overrides.month),
  );
  const dayRank = RANK[dayLevel];
  const monthRank = RANK[monthLevel];
  let level: SpendLevel = "ok";
  let scope: SpendScope | null = null;
  if (dayRank > monthRank) {
    level = dayLevel;
    scope = "day";
  } else if (monthRank > dayRank) {
    level = monthLevel;
    scope = "month";
  } else if (dayRank > 0) {
    level = dayLevel;
    scope = "day";
  }
  const allow = !pausedBy(level, routePriority(route));
  const resumeAt = !allow && scope ? resumeAtMs(scope, nowMs, timeZone) : null;
  return { allow, level, scope, resumeAt };
}

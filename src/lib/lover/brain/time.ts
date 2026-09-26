import { DAY_BOUNDARY_HOUR, SESSION_GAP_MS } from "./config.ts";

export function dayPartLabel(hour: number): string {
  if (hour < 5) return "凌晨";
  if (hour < 11) return "早上";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  if (hour < 23) return "晚上";
  return "深夜";
}

export function formatClock(nowMs: number, timeZone: string): string {
  try {
    const base = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      weekday: "short",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(nowMs));
    return `${base}（${dayPartLabel(zonedParts(nowMs, timeZone).hour)}）`;
  } catch {
    return new Date(nowMs).toISOString();
  }
}

export function zonedParts(ms: number, timeZone: string) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(new Date(ms));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
    };
  } catch {
    const d = new Date(ms);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
  }
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function addDays(year: number, month: number, day: number, delta: number) {
  const utc = Date.UTC(year, month - 1, day + delta);
  const d = new Date(utc);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function localDay(ms: number, timeZone: string, boundaryHour = DAY_BOUNDARY_HOUR): string {
  const p = zonedParts(ms, timeZone);
  if (p.hour < boundaryHour) {
    const prev = addDays(p.year, p.month, p.day, -1);
    return isoDate(prev.year, prev.month, prev.day);
  }
  return isoDate(p.year, p.month, p.day);
}

export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const next = addDays(y, m, d, delta);
  return isoDate(next.year, next.month, next.day);
}

export function yearMonth(day: string): string {
  return day.slice(0, 7);
}

export function previousMonth(nowMs: number, timeZone: string): string {
  const day = localDay(nowMs, timeZone);
  const [y, m] = day.split("-").map(Number);
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return `${prev.y}-${pad(prev.m)}`;
}

export function monthRange(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number);
  const start = isoDate(y, m, 1);
  const next = m === 12 ? isoDate(y + 1, 1, 1) : isoDate(y, m + 1, 1);
  return { start, end: shiftDay(next, -1) };
}

export function sessionIdFor(
  createdAt: number,
  previous: { createdAt: number; sessionId: string } | null,
  timeZone: string,
): string {
  if (!previous || createdAt - previous.createdAt >= SESSION_GAP_MS) {
    return `s:${createdAt}`;
  }
  return previous.sessionId || `s:${createdAt}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** "HH:MM" in her zone. */
export function clockOf(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

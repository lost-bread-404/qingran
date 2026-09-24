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

export function localHour(ms: number, timeZone: string): number {
  return zonedParts(ms, timeZone).hour;
}

export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const next = addDays(y, m, d, delta);
  return isoDate(next.year, next.month, next.day);
}

export function daysInclusive(from: string, to: string): string[] {
  if (from > to) return [];
  const out: string[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = shiftDay(cur, 1);
    if (out.length > 400) break;
  }
  return out;
}

export function yesterday(nowMs: number, timeZone: string): string {
  return shiftDay(localDay(nowMs, timeZone), -1);
}

/** ISO week like 2026-W38 (Monday-start, ISO-8601). */
export function isoWeek(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const utcDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - utcDay);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

export function isoWeekStart(week: string): string {
  const match = week.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return week;
  const year = Number(match[1]);
  const w = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (w - 1) * 7);
  return isoDate(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

export function currentIsoWeek(nowMs: number, timeZone: string): string {
  return isoWeek(localDay(nowMs, timeZone));
}

export function previousIsoWeek(nowMs: number, timeZone: string): string {
  return isoWeek(shiftDay(localDay(nowMs, timeZone), -7));
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

export function afterBoundary(nowMs: number, timeZone: string, hour = DAY_BOUNDARY_HOUR): boolean {
  return zonedParts(nowMs, timeZone).hour >= hour;
}

/** 04:00 日界内，02:00–03:59 算熬夜。没有 last_active 则为未知。 */
export function overnightValue(lastActive: number | null, timeZone: string): 1 | 0 | null {
  if (lastActive == null) return null;
  const hour = localHour(lastActive, timeZone);
  return hour >= 2 && hour < 4 ? 1 : 0;
}

export function clipChars(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

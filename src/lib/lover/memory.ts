import { similar } from "./brain/text.ts";
import { newId } from "./storage.ts";
import type { Memory } from "./types.ts";

export { similar };

const MAX_MANUAL_CHARS = 160;

export function sortMemoriesByTime(memories: Memory[], newestFirst = false): Memory[] {
  return memories.slice().sort((a, b) => {
    const da = a.createdAt || 0;
    const db = b.createdAt || 0;
    if (da !== db) return newestFirst ? db - da : da - db;
    return (a.id || "").localeCompare(b.id || "");
  });
}

export function addManualMemory(
  existing: Memory[],
  text: string,
  at = Date.now(),
): Memory[] {
  const fact = text.replace(/\s+/g, " ").trim();
  if (fact.length < 2) return existing;
  const when = Number.isFinite(at) && at > 0 ? at : Date.now();
  const clipped =
    fact.length > MAX_MANUAL_CHARS ? `${fact.slice(0, MAX_MANUAL_CHARS - 1)}…` : fact;
  const idx = existing.findIndex((m) => similar(m.text, clipped));
  if (idx >= 0) {
    const next = [...existing];
    next[idx] = { ...next[idx], text: clipped, createdAt: when, updatedAt: Date.now() };
    return next;
  }
  return [
    ...existing,
    {
      id: newId(),
      text: clipped,
      createdAt: when,
      updatedAt: Date.now(),
    },
  ].slice(-80);
}

export function updateMemory(
  existing: Memory[],
  id: string,
  text: string,
  createdAt?: number,
): Memory[] {
  const fact = text.replace(/\s+/g, " ").trim();
  if (!fact) return existing.filter((m) => m.id !== id);
  const clipped =
    fact.length > MAX_MANUAL_CHARS ? `${fact.slice(0, MAX_MANUAL_CHARS - 1)}…` : fact;
  const when =
    createdAt != null && Number.isFinite(createdAt) && createdAt > 0 ? createdAt : undefined;
  return existing.map((m) =>
    m.id === id
      ? { ...m, text: clipped, createdAt: when ?? m.createdAt, updatedAt: Date.now() }
      : m,
  );
}

export function toDatetimeLocal(ms: number) {
  const d = new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now());
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDatetimeLocal(value: string, fallback = Date.now()) {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return fallback;
  const at = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ).getTime();
  return Number.isFinite(at) ? at : fallback;
}

export function splitLeadingTimestamp(raw: string): { at: number | null; text: string } {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { at: null, text: "" };
  const match = text.match(
    /^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!match) return { at: null, text };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return { at: null, text };
  }
  const hour = match[4] != null ? Number(match[4]) : 0;
  const minute = match[5] != null ? Number(match[5]) : 0;
  const second = match[6] != null ? Number(match[6]) : 0;
  if (hour > 23 || minute > 59 || second > 59) return { at: null, text };
  const at = new Date(year, month - 1, day, hour, minute, second).getTime();
  if (!Number.isFinite(at)) return { at: null, text };
  const rest = text.slice(match[0].length).replace(/^[\s，,、.。:：\-—]+/, "").trim();
  return { at, text: rest || text };
}

export function resolveManualMemory(
  raw: string,
  timeValue: string,
  timeTouched: boolean,
  now = Date.now(),
): { text: string; at: number } {
  const parsed = splitLeadingTimestamp(raw);
  const text = (parsed.at ? parsed.text : raw).replace(/\s+/g, " ").trim();
  if (timeTouched) return { text, at: fromDatetimeLocal(timeValue, now) };
  if (parsed.at) return { text: parsed.text, at: parsed.at };
  return { text, at: now };
}

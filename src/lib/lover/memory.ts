import { newId } from "./storage.ts";
import type { Memory } from "./types.ts";

const MAX_PROMPT_CHARS = 1800;
const MAX_FACTS_PER_TURN = 1;
const MAX_FACT_CHARS = 80;
const MAX_MANUAL_CHARS = 160;

const MAJOR =
  /分手|复合|搬家|搬出去|搬了出去|搬离|同居|失业|找不到工作|找到工作|崩溃|结婚|订婚|住院|出事|离开|冷战|出轨|怀孕|见家长|提出分手|提分手/;
const FLUFF =
  /蹭了蹭|撒娇|抱抱|亲亲|依偎|摸头|轻轻抱|怀里|吻了|抱紧|蹭着/;

export function looksLikeMajorEvent(text: string): boolean {
  return MAJOR.test(text);
}

export function isMajorMemory(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 12) return false;
  if (MAJOR.test(t)) return true;
  if (FLUFF.test(t)) return false;
  return t.length >= 22 && /因为|之后|决定|搬|离开|在一起|分开|不再|从.*搬/.test(t);
}

export function sortMemoriesByTime(memories: Memory[], newestFirst = false): Memory[] {
  return memories.slice().sort((a, b) => {
    const da = a.createdAt || 0;
    const db = b.createdAt || 0;
    if (da !== db) return newestFirst ? db - da : da - db;
    return (a.id || "").localeCompare(b.id || "");
  });
}

export function memoriesForPrompt(memories: Memory[], query: string): Memory[] {
  if (memories.length === 0) return [];
  const terms = tokenize(query);
  const ranked = memories
    .map((m) => ({ m, score: scoreMemory(m, terms) }))
    .sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt);

  const picked: Memory[] = [];
  let used = 0;
  for (const { m } of ranked) {
    const cost = m.text.length + 8;
    if (picked.length > 0 && used + cost > MAX_PROMPT_CHARS) continue;
    picked.push(m);
    used += cost;
    if (picked.length >= 18) break;
  }
  return sortMemoriesByTime(picked);
}

export function mergeFacts(existing: Memory[], facts: string[], at = Date.now()): Memory[] {
  const next = [...existing];
  const cleaned = facts
    .map((f) => f.replace(/\s+/g, " ").trim())
    .filter((f) => isMajorMemory(f))
    .slice(0, MAX_FACTS_PER_TURN)
    .map((f) => (f.length > MAX_FACT_CHARS ? `${f.slice(0, MAX_FACT_CHARS - 1)}…` : f));

  for (const fact of cleaned) {
    const idx = next.findIndex((m) => similar(m.text, fact));
    if (idx >= 0) {
      const prev = next[idx];
      const keep = prev.text.length >= fact.length ? prev.text : fact;
      next[idx] = { ...prev, text: keep, updatedAt: Date.now() };
    } else {
      next.push({
        id: newId(),
        text: fact,
        createdAt: at,
        updatedAt: Date.now(),
      });
    }
  }
  return next.slice(-80);
}

export function replaceMemories(
  facts: Array<{ text: string; createdAt?: number }>,
): Memory[] {
  const now = Date.now();
  return facts
    .map((fact) => fact.text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length >= 2)
    .slice(0, 80)
    .map((text, i) => {
      const clipped = text.length > 160 ? `${text.slice(0, 159)}…` : text;
      const createdAt = facts[i]?.createdAt && facts[i]!.createdAt! > 0 ? facts[i]!.createdAt! : now;
      return {
        id: newId(),
        text: clipped,
        createdAt,
        updatedAt: now,
      };
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

function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const words = lowered.match(/[a-z0-9]{2,}|[\u4e00-\u9fff]/g) ?? [];
  return [...new Set(words)].slice(0, 24);
}

function scoreMemory(memory: Memory, terms: string[]): number {
  const hay = memory.text.toLowerCase();
  let hits = 0;
  for (const t of terms) {
    if (hay.includes(t)) hits += t.length > 1 ? 2 : 1;
  }
  const ageDays = (Date.now() - memory.updatedAt) / 86_400_000;
  const recency = ageDays < 3 ? 2 : ageDays < 14 ? 1 : 0;
  return hits + recency;
}

export function similar(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length < 8) return false;
  let hits = 0;
  const used = new Set<number>();
  for (const ch of short) {
    const idx = [...long].findIndex((c, i) => c === ch && !used.has(i));
    if (idx >= 0) {
      used.add(idx);
      hits += 1;
    }
  }
  return hits / short.length >= 0.78;
}

function norm(s: string): string {
  return s.replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, "").toLowerCase();
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

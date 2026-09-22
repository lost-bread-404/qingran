import { PICK_MAX } from "./config.ts";
import type { Mind } from "./types.ts";
import { EMPTY_MIND } from "./types.ts";

function clipPlain(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max);
}

function asStringList(raw: unknown, max: number, each: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => clipPlain(s, each))
    .filter(Boolean)
    .slice(0, max);
}

export function coerceMind(raw: unknown, turnSeq = 0, updatedAt?: number): Mind {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const insight = typeof row.insight === "string" ? row.insight : "";
  const memory_ids = asStringList(row.memory_ids, PICK_MAX, 80);
  const mind: Mind = { ...EMPTY_MIND, turn_seq: turnSeq, insight, memory_ids };
  if (updatedAt) mind.updated_at = updatedAt;
  return mind;
}

export function validateMind(raw: unknown, _prev: Mind, allowedIds: Set<string>): Mind {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const insight = clipPlain(String(row.insight ?? ""), 1200);
  const memory_ids = asStringList(row.memory_ids, PICK_MAX, 80).filter((id) => allowedIds.has(id));
  if (!insight) {
    return { ...EMPTY_MIND, memory_ids };
  }
  return { ...EMPTY_MIND, insight, memory_ids };
}

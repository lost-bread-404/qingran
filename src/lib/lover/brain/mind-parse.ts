import { PICK_MAX } from "./config.ts";
import { clamp, clipChars } from "./time.ts";
import type { Mind, MindReading } from "./types.ts";

function asReading(raw: unknown): MindReading[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 3)
    .map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as { guess?: unknown; conf?: unknown };
      return {
        guess: clipChars(String(row.guess ?? ""), 80),
        conf: clamp(Number(row.conf) || 0, 0, 1),
      };
    })
    .filter((r) => r.guess);
}

function asStringList(raw: unknown, max: number, each: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => clipChars(s, each))
    .filter(Boolean)
    .slice(0, max);
}

export function validateMind(raw: unknown, prev: Mind, allowedIds: Set<string>): Mind {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const lead = asStringList(row.lead_plan, 3, 80);
  const recent = [...(prev.recent_intents ?? [])];
  const intent = clipChars(String(row.intent ?? prev.intent), 60);
  if (intent) {
    recent.push(intent);
    while (recent.length > 3) recent.shift();
  }
  return {
    turn_seq: prev.turn_seq,
    rosie_now: clipChars(String(row.rosie_now ?? prev.rosie_now), 80) || prev.rosie_now,
    undercurrent: clipChars(String(row.undercurrent ?? prev.undercurrent), 60) || prev.undercurrent,
    reading: asReading(row.reading).length ? asReading(row.reading) : prev.reading,
    soft_spot: clipChars(String(row.soft_spot ?? ""), 40),
    my_feel: clipChars(String(row.my_feel ?? prev.my_feel), 50) || prev.my_feel,
    my_view: clipChars(String(row.my_view ?? prev.my_view), 80) || prev.my_view,
    my_logic: clipChars(String(row.my_logic ?? prev.my_logic), 100) || prev.my_logic,
    lead_plan: lead.length ? lead : prev.lead_plan,
    intent: intent || prev.intent,
    threads: asStringList(row.threads, 4, 60),
    recent_intents: recent,
    memory_ids: asStringList(row.memory_ids, PICK_MAX, 80).filter((id) => allowedIds.has(id)),
  };
}

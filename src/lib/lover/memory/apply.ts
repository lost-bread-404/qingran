import type { ChatMessage } from "../types.ts";
import { parseMaybeTime } from "./prompts.ts";
import type { ArchiveA, OpenEvent } from "./types.ts";

export type FactPlan = {
  startedAt: number;
  endedAt: number;
  text: string;
};

export type ArchivePlan = {
  scannedIds: string[];
  open: OpenEvent[];
  facts: FactPlan[];
};

export function planArchive(opts: {
  archive: ArchiveA;
  dropped: ChatMessage[];
  now?: number;
}): ArchivePlan {
  const now = opts.now ?? Date.now();
  const fallback = opts.dropped[0]?.createdAt || now;
  const seen = new Set<string>();
  const facts: FactPlan[] = [];
  for (const fact of opts.archive.facts) {
    const text = fact.text.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const at = parseMaybeTime(fact.time, fallback);
    facts.push({ startedAt: at, endedAt: at, text });
  }
  const open: OpenEvent[] = [];
  for (const item of opts.archive.open) {
    const text = item.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    open.push({
      id: item.id.trim() || "",
      startedAt: parseMaybeTime(item.started, fallback),
      text: text.slice(0, 800),
    });
  }
  return {
    scannedIds: opts.dropped.map((m) => m.id),
    open,
    facts,
  };
}

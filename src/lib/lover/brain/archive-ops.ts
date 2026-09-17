import { newId } from "../storage.ts";
import { now as wallClock } from "./clock.ts";
import { similar } from "./text.ts";
import { localDay } from "./time.ts";
import type { Lens, Note, StoredMessage, Subject } from "./types.ts";

export type RawOp = {
  op?: string;
  target_id?: string;
  text?: string;
  tags?: unknown;
  subject?: string;
  lens?: unknown;
  from_rosie?: unknown;
  weight?: unknown;
  links?: unknown;
  happened_at?: string;
  source_ids?: unknown;
};

function clip(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n);
}

function asStrings(raw: unknown, max: number, each: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => clip(s, each))
    .filter(Boolean)
    .slice(0, max);
}

export function validateOps(
  ops: RawOp[],
  batch: StoredMessage[],
  candidates: Note[],
): Array<{ note: Note; supersede?: string; links: string[] }> {
  const batchIds = new Set(batch.map((m) => m.id));
  const candMap = new Map(candidates.map((n) => [n.id, n]));
  const out: Array<{ note: Note; supersede?: string; links: string[] }> = [];
  const now = wallClock();

  for (const raw of ops) {
    const text = clip(String(raw.text ?? ""), 120);
    if (!text) continue;
    const sourceIds = asStrings(raw.source_ids, 12, 80).filter((id) => batchIds.has(id));
    if (!sourceIds.length) continue;
    const sources = batch.filter((m) => sourceIds.includes(m.id));
    const allAssistant = sources.every((m) => m.role === "assistant");
    let fromRosie = Boolean(raw.from_rosie);
    if (allAssistant) fromRosie = false;
    const subject: Subject =
      raw.subject === "qingran" || raw.subject === "us" || raw.subject === "rosie" ? raw.subject : "rosie";
    const lens = asStrings(raw.lens, 2, 10).filter((x): x is Lens => x === "diary" || x === "bond");
    if (!lens.length) continue;
    const tags = asStrings(raw.tags, 6, 10);
    const weight = Math.min(5, Math.max(1, Math.round(Number(raw.weight) || 3)));
    const links = asStrings(raw.links, 6, 80).filter((id) => candMap.has(id));
    let op = raw.op === "SUPERSEDE" ? "SUPERSEDE" : "ADD";
    let target = String(raw.target_id ?? "");
    if (op === "SUPERSEDE" && !candMap.has(target)) op = "ADD";

    const dup = candidates.find((c) => similar(c.text, text));
    if (op === "ADD" && dup) {
      op = "SUPERSEDE";
      target = dup.id;
    }

    const happenedAt = sources[0]?.createdAt || now;
    const day = sources[0]?.localDay || localDay(happenedAt, "UTC");
    let mergedSources = sourceIds;
    let mergedLinks = links;
    if (op === "SUPERSEDE" && target) {
      const old = candMap.get(target);
      mergedSources = [...new Set([...(old?.sourceIds ?? []), ...sourceIds])].slice(0, 12);
      mergedLinks = [...new Set([...links, target])].slice(0, 6);
    }
    const id = `n:${newId()}`;
    out.push({
      note: {
        id,
        text,
        tags,
        subject,
        lens,
        fromRosie,
        weight,
        status: "active",
        supersededBy: null,
        links: mergedLinks,
        happenedAt,
        localDay: day,
        sourceIds: mergedSources,
        recallCount: 0,
        lastRecalledAt: null,
        createdAt: now,
        updatedAt: now,
      },
      supersede: op === "SUPERSEDE" ? target : undefined,
      links: mergedLinks,
    });
  }
  return out;
}

import { clampPortraitActiveMax, clampPortraitStaleDays } from "../config.ts";
import {
  DROP_PORTRAIT_TOPICS,
  EVENT_TEXT_RE,
  isConfirmedEventPortrait,
  isStorySeedPortrait,
  portraitKindOf,
} from "../portrait-kind.ts";
import { isQingranBehaviorRecap } from "../memory-hygiene.ts";
import { similar } from "../text.ts";
import { clipChars, localDay } from "../time.ts";
import type { PortraitRow, PortraitStatus } from "../types.ts";

export const RELATIONSHIP_TOPIC = "关系阶段";
export const PORTRAIT_BODY_MAX = 80;
export const RELATIONSHIP_BODY_MAX = 160;
const DAY_MS = 86_400_000;
const EVIDENCE_CAP = 40;

export type PortraitOp = {
  id?: string;
  topic?: string;
  body?: string;
  kind?: string;
  evidence_ids?: string[];
  verdict?: string;
};

export function normalizePortrait(
  row: Partial<PortraitRow> & Pick<PortraitRow, "id" | "topic" | "body">,
): PortraitRow {
  const status = normalizeStatus(row.status);
  const kind = portraitKindOf(row);
  const updatedAt = num(row.updatedAt);
  const lastSeen = num(row.lastSeen) || updatedAt;
  const lastSupportedAt = num(row.lastSupportedAt) || updatedAt || lastSeen;
  const rawCount = Number(row.supportCount);
  const supportCount = Number.isFinite(rawCount) && rawCount >= 1 ? Math.round(rawCount) : 1;
  return {
    id: row.id,
    topic: row.topic,
    body: row.body,
    status,
    kind,
    evidenceIds: [...(row.evidenceIds ?? [])],
    lastSeen,
    lastSupportedAt,
    supportCount,
    updatedAt: updatedAt || lastSupportedAt,
  };
}

export function portraitRetireReason(row: PortraitRow, evidenceDays: Map<string, string>): string | null {
  if (isStorySeedPortrait(row) || row.topic === RELATIONSHIP_TOPIC) return null;
  if (row.status !== "active") return null;
  if (isConfirmedEventPortrait(row)) return "具体事件";
  if (distinctDays(row.evidenceIds, evidenceDays).size < 2) return "依据不足 2 个不同日期";
  if (EVENT_TEXT_RE.test(`${row.topic}${row.body}`)) return "看起来像某一次的事";
  return null;
}

/** Active rows that lack two dates and were not part of the confirmed event cleanup. */
export function thinEvidenceCandidates(rows: PortraitRow[], evidenceDays: Map<string, string>): PortraitRow[] {
  return rows.filter((row) => {
    if (isStorySeedPortrait(row) || row.topic === RELATIONSHIP_TOPIC) return false;
    if (row.status !== "active") return false;
    if (isConfirmedEventPortrait(row)) return false;
    return distinctDays(row.evidenceIds, evidenceDays).size < 2;
  });
}

export function formatOldPortrait(rows: PortraitRow[], timeZone: string): string {
  const shown = rows
    .filter((row) => !isStorySeedPortrait(row) && (row.status === "active" || row.status === "stale"))
    .map((row) => normalizePortrait(row));
  if (!shown.length) return "";
  return shown
    .map((row) => {
      const when = row.lastSupportedAt ? localDay(row.lastSupportedAt, timeZone) : "";
      return `${row.id}|${row.status}|${row.kind}|${row.supportCount}|${when}|${row.topic}|${row.body}|${row.evidenceIds.join(",")}`;
    })
    .join("\n");
}

export function formatPortraitNoteLine(note: { id: string; localDay: string; subject: string; text: string }): string {
  return `${note.id}|${note.localDay}|${note.subject}|${clipChars(note.text, PORTRAIT_BODY_MAX)}`;
}

export function applyPortraitReview(input: {
  existing: PortraitRow[];
  ops: PortraitOp[];
  relationship?: { body?: string; evidence_ids?: string[] };
  evidenceDays: Map<string, string>;
  now: number;
  activeMax: number;
  staleDays: number;
  allocateId?: () => string;
}): PortraitRow[] {
  const rows = input.existing.map((row) => normalizePortrait(row));
  const activeMax = clampPortraitActiveMax(input.activeMax);
  const staleDays = clampPortraitStaleDays(input.staleDays);
  let seq = 0;
  const allocateId = input.allocateId ?? (() => `p:new-${input.now}-${++seq}`);
  let relationshipBody = clipChars(String(input.relationship?.body ?? "").trim(), RELATIONSHIP_BODY_MAX);
  let relationshipEvidence = knownIds(input.relationship?.evidence_ids, input.evidenceDays);

  for (const op of input.ops) {
    const topic = clipChars(String(op.topic ?? "").trim(), 40);
    const body = clipChars(String(op.body ?? "").trim(), topic === RELATIONSHIP_TOPIC ? RELATIONSHIP_BODY_MAX : PORTRAIT_BODY_MAX);
    const evidence = knownIds(op.evidence_ids, input.evidenceDays);
    const prev = findRow(rows, { id: String(op.id ?? "").trim(), topic });
    const verdict = op.verdict === "support" || op.verdict === "supersede" || op.verdict === "new"
      ? op.verdict
      : prev && prev.status !== "superseded"
        ? "support"
        : "new";

    if (topic === RELATIONSHIP_TOPIC) {
      if (body && !relationshipBody) {
        relationshipBody = body;
        relationshipEvidence = evidence;
      }
      continue;
    }

    if ((prev && isStorySeedPortrait(prev)) || isStorySeedPortrait({ id: String(op.id ?? ""), topic })) continue;

    if (verdict === "supersede") {
      if (prev && prev.topic !== RELATIONSHIP_TOPIC) markSuperseded(prev, input.now);
      continue;
    }

    if (op.kind === "episode") continue;
    if (body && isQingranBehaviorRecap(`${topic}${body}`)) continue;
    if (topic && (DROP_PORTRAIT_TOPICS as readonly string[]).includes(topic)) continue;

    if (prev && prev.status !== "superseded" && prev.topic !== RELATIONSHIP_TOPIC) {
      if ((DROP_PORTRAIT_TOPICS as readonly string[]).includes(prev.topic)) continue;
      trySupport(prev, body, evidence, input.evidenceDays, input.now);
      continue;
    }

    if (verdict !== "new" || !topic || !body) continue;
    const alike = rows.find(
      (row) =>
        !isStorySeedPortrait(row) &&
        row.status !== "superseded" &&
        row.topic !== RELATIONSHIP_TOPIC &&
        (row.topic === topic || similar(row.topic, topic)),
    );
    if (alike) {
      if ((DROP_PORTRAIT_TOPICS as readonly string[]).includes(alike.topic)) continue;
      trySupport(alike, body, evidence, input.evidenceDays, input.now);
      continue;
    }
    if (distinctDays(evidence, input.evidenceDays).size < 2) continue;
    rows.push({
      id: allocateId(),
      topic,
      body,
      status: "active",
      kind: "trait",
      evidenceIds: mergeIds([], evidence),
      lastSeen: input.now,
      lastSupportedAt: input.now,
      supportCount: 1,
      updatedAt: input.now,
    });
  }

  touchRelationship(rows, relationshipBody, relationshipEvidence, input.now, allocateId);

  for (const row of rows) {
    if (row.status !== "active" || row.topic === RELATIONSHIP_TOPIC || isStorySeedPortrait(row)) continue;
    if (input.now - row.lastSupportedAt > staleDays * DAY_MS) row.status = "stale";
  }

  const active = rows
    .filter((row) => row.status === "active" && row.topic !== RELATIONSHIP_TOPIC && !isStorySeedPortrait(row))
    .sort(
      (a, b) =>
        b.supportCount - a.supportCount ||
        b.lastSupportedAt - a.lastSupportedAt ||
        a.id.localeCompare(b.id),
    );
  const keep = new Set(active.slice(0, activeMax).map((row) => row.id));
  for (const row of active) {
    if (!keep.has(row.id)) row.status = "stale";
  }
  return rows;
}

function touchRelationship(
  rows: PortraitRow[],
  body: string,
  evidence: string[],
  now: number,
  allocateId: () => string,
): void {
  const existing = rows.filter((row) => row.topic === RELATIONSHIP_TOPIC);
  const keep = existing[0];
  for (const extra of existing.slice(1)) markSuperseded(extra, now);
  if (!body) return;
  if (keep) {
    keep.body = body;
    keep.kind = "trait";
    keep.status = "active";
    keep.evidenceIds = mergeIds(keep.evidenceIds, evidence);
    keep.lastSupportedAt = now;
    keep.lastSeen = now;
    keep.updatedAt = now;
    keep.supportCount += 1;
    return;
  }
  rows.push({
    id: allocateId(),
    topic: RELATIONSHIP_TOPIC,
    body,
    status: "active",
    kind: "trait",
    evidenceIds: mergeIds([], evidence),
    lastSeen: now,
    lastSupportedAt: now,
    supportCount: 1,
    updatedAt: now,
  });
}

function trySupport(
  row: PortraitRow,
  body: string,
  evidence: string[],
  days: Map<string, string>,
  now: number,
): void {
  if (isStorySeedPortrait(row) || row.kind === "episode" || row.status === "superseded") return;
  if (!evidence.length) return;
  const merged = mergeIds(row.evidenceIds, evidence);
  if (distinctDays(merged, days).size < 2) return;
  if (body) row.body = body;
  row.kind = "trait";
  row.status = "active";
  row.evidenceIds = merged;
  row.lastSupportedAt = now;
  row.lastSeen = now;
  row.updatedAt = now;
  row.supportCount += 1;
}

function markSuperseded(row: PortraitRow, now: number): void {
  if (isStorySeedPortrait(row) || row.topic === RELATIONSHIP_TOPIC) return;
  row.status = "superseded";
  row.updatedAt = now;
}

function findRow(rows: PortraitRow[], op: { id?: string; topic?: string }): PortraitRow | undefined {
  const id = op.id?.trim();
  if (id) {
    const byId = rows.find((row) => row.id === id);
    if (byId) return byId;
  }
  const topic = op.topic?.trim();
  if (!topic || topic === RELATIONSHIP_TOPIC) return undefined;
  const pool = rows.filter((row) => row.topic !== RELATIONSHIP_TOPIC && !isStorySeedPortrait(row));
  return (
    pool.find((row) => row.topic === topic && row.status !== "superseded") ||
    pool.find((row) => row.status !== "superseded" && similar(row.topic, topic)) ||
    pool.find((row) => row.topic === topic) ||
    pool.find((row) => similar(row.topic, topic))
  );
}

function knownIds(ids: string[] | undefined, days: Map<string, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids ?? []) {
    if (!id || seen.has(id) || !days.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function mergeIds(a: string[], b: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...a, ...b]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > EVIDENCE_CAP ? out.slice(out.length - EVIDENCE_CAP) : out;
}

function distinctDays(ids: string[], days: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const day = days.get(id);
    if (day) out.add(day);
  }
  return out;
}

function normalizeStatus(status: string | undefined): PortraitStatus {
  if (status === "stale" || status === "dormant") return "stale";
  if (status === "superseded") return "superseded";
  return "active";
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

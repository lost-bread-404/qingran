import { getSql } from "@/lib/db";
import { newId } from "../storage";
import {
  applyMemoryCursor,
  type ChatMessage,
  type MessageKind,
} from "../types";
import type {
  L1Event,
  L2Event,
  L3Pattern,
  MemoryBoard,
  MemoryItem,
  OpenEvent,
  PatternDraft,
  Retrievable,
} from "./types";

export type MemoryMeta = {
  lastIntervalAt: number;
  lastIntervalDay: string;
  intervalRetryAt: number;
  timeZone: string;
};

export async function loadAllMessages(): Promise<ChatMessage[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    role: ChatMessage["role"];
    body: string;
    created_at: number;
    scanned: boolean;
  }>`
    select id, role, body, created_at, scanned
    from qingran_messages
    order by created_at asc,
      case when role = 'user' then 0 else 1 end asc,
      id asc
  `;
  return rows.map(decodeStoredMessage);
}

export async function markScanned(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const sql = await getSql();
  for (const id of ids) {
    await sql`update qingran_messages set scanned = true where id = ${id}`;
  }
}

export async function loadOpenEvent(): Promise<OpenEvent | null> {
  const sql = await getSql();
  const [row] = await sql<{ started_at: number; draft: string; points: string }>`
    select started_at, draft, points from qingran_open_event where id = 1
  `;
  if (!row) return null;
  const draft = row.draft.trim();
  if (!draft) return null;
  return {
    startedAt: Number(row.started_at) || Date.now(),
    draft,
    points: row.points ?? "",
  };
}

export async function saveOpenEvent(event: OpenEvent | null): Promise<void> {
  const sql = await getSql();
  if (!event || !event.draft.trim()) {
    await sql`delete from qingran_open_event where id = 1`;
    return;
  }
  const now = Date.now();
  await sql`
    insert into qingran_open_event (id, started_at, draft, points, updated_at)
    values (1, ${event.startedAt}, ${event.draft.slice(0, 800)}, ${event.points.slice(0, 2400)}, ${now})
    on conflict (id) do update
      set started_at = excluded.started_at,
          draft = excluded.draft,
          points = excluded.points,
          updated_at = excluded.updated_at
  `;
}

export async function insertL1(event: Omit<L1Event, "id" | "createdAt"> & { id?: string }): Promise<L1Event> {
  const sql = await getSql();
  const row: L1Event = {
    id: event.id || newId(),
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    text: event.text.slice(0, 600),
    createdAt: Date.now(),
  };
  await sql`
    insert into qingran_l1 (id, started_at, ended_at, text, created_at)
    values (${row.id}, ${row.startedAt}, ${row.endedAt}, ${row.text}, ${row.createdAt})
    on conflict (id) do update
      set text = excluded.text, ended_at = excluded.ended_at
  `;
  return row;
}

export async function insertL2(event: Omit<L2Event, "id" | "createdAt">): Promise<L2Event> {
  const sql = await getSql();
  const row: L2Event = {
    id: newId(),
    periodStart: event.periodStart,
    periodEnd: event.periodEnd,
    text: event.text.slice(0, 1600),
    createdAt: Date.now(),
  };
  await sql`
    insert into qingran_l2 (id, period_start, period_end, text, created_at)
    values (${row.id}, ${row.periodStart}, ${row.periodEnd}, ${row.text}, ${row.createdAt})
  `;
  return row;
}

export async function loadL1(): Promise<L1Event[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    started_at: number;
    ended_at: number;
    text: string;
    created_at: number;
  }>`select id, started_at, ended_at, text, created_at from qingran_l1 order by ended_at desc`;
  return rows.map((row) => ({
    id: row.id,
    startedAt: Number(row.started_at),
    endedAt: Number(row.ended_at),
    text: row.text,
    createdAt: Number(row.created_at),
  }));
}

export async function loadL1Since(since: number): Promise<L1Event[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    started_at: number;
    ended_at: number;
    text: string;
    created_at: number;
  }>`
    select id, started_at, ended_at, text, created_at
    from qingran_l1
    where created_at >= ${since} or ended_at >= ${since}
    order by ended_at asc
  `;
  return rows.map((row) => ({
    id: row.id,
    startedAt: Number(row.started_at),
    endedAt: Number(row.ended_at),
    text: row.text,
    createdAt: Number(row.created_at),
  }));
}

export async function loadL2(): Promise<L2Event[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    period_start: number;
    period_end: number;
    text: string;
    created_at: number;
  }>`select id, period_start, period_end, text, created_at from qingran_l2 order by period_end desc`;
  return rows.map((row) => ({
    id: row.id,
    periodStart: Number(row.period_start),
    periodEnd: Number(row.period_end),
    text: row.text,
    createdAt: Number(row.created_at),
  }));
}

export async function loadL3(): Promise<L3Pattern[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    status: string;
    text: string;
    last_evidence_at: number;
    created_at: number;
    updated_at: number;
  }>`select id, status, text, last_evidence_at, created_at, updated_at from qingran_l3 order by updated_at desc`;
  return rows.map((row) => ({
    id: row.id,
    status: row.status === "dormant" ? "dormant" : "active",
    text: row.text,
    lastEvidenceAt: Number(row.last_evidence_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export async function replaceL3(patterns: PatternDraft[], now: number): Promise<void> {
  const sql = await getSql();
  const existing = await loadL3();
  const used = new Set<string>();
  for (const pattern of patterns) {
    const text = pattern.text.slice(0, 400);
    if (!text) continue;
    const found = existing.find((item) => similarText(item.text, text) && !used.has(item.id));
    const evidence = parseLooseTime(pattern.time, now);
    if (found) {
      used.add(found.id);
      await sql`
        update qingran_l3
        set status = ${pattern.status},
            text = ${text},
            last_evidence_at = ${pattern.status === "active" ? evidence : found.lastEvidenceAt},
            updated_at = ${now}
        where id = ${found.id}
      `;
    } else {
      const id = newId();
      used.add(id);
      await sql`
        insert into qingran_l3 (id, status, text, last_evidence_at, created_at, updated_at)
        values (${id}, ${pattern.status}, ${text}, ${evidence}, ${now}, ${now})
      `;
    }
  }
}

export async function loadPortrait(): Promise<string> {
  const sql = await getSql();
  const [row] = await sql<{ body: string }>`select body from qingran_portrait where id = 1`;
  return row?.body?.trim() ?? "";
}

export async function savePortrait(body: string): Promise<void> {
  const sql = await getSql();
  await sql`
    insert into qingran_portrait (id, body, updated_at)
    values (1, ${body.slice(0, 2400)}, ${Date.now()})
    on conflict (id) do update set body = excluded.body, updated_at = excluded.updated_at
  `;
}

export async function loadMeta(): Promise<MemoryMeta> {
  const sql = await getSql();
  const [row] = await sql<{
    last_interval_at: number;
    last_interval_day: string;
    interval_retry_at: number;
    time_zone: string;
  }>`select last_interval_at, last_interval_day, interval_retry_at, time_zone from qingran_memory_meta where id = 1`;
  return {
    lastIntervalAt: Number(row?.last_interval_at) || 0,
    lastIntervalDay: row?.last_interval_day ?? "",
    intervalRetryAt: Number(row?.interval_retry_at) || 0,
    timeZone: row?.time_zone || "UTC",
  };
}

export async function saveMeta(meta: Partial<MemoryMeta> & { timeZone?: string }): Promise<void> {
  const sql = await getSql();
  const current = await loadMeta();
  const next: MemoryMeta = {
    lastIntervalAt: meta.lastIntervalAt ?? current.lastIntervalAt,
    lastIntervalDay: meta.lastIntervalDay ?? current.lastIntervalDay,
    intervalRetryAt: meta.intervalRetryAt ?? current.intervalRetryAt,
    timeZone: meta.timeZone ?? current.timeZone,
  };
  await sql`
    insert into qingran_memory_meta (id, last_interval_at, last_interval_day, interval_retry_at, time_zone)
    values (1, ${next.lastIntervalAt}, ${next.lastIntervalDay}, ${next.intervalRetryAt}, ${next.timeZone})
    on conflict (id) do update
      set last_interval_at = excluded.last_interval_at,
          last_interval_day = excluded.last_interval_day,
          interval_retry_at = excluded.interval_retry_at,
          time_zone = excluded.time_zone
  `;
}

export async function appendLog(
  kind: string,
  note: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const sql = await getSql();
  await sql`
    insert into qingran_memory_log (id, kind, note, payload, created_at)
    values (${newId()}, ${kind}, ${note.slice(0, 80)}, ${JSON.stringify(payload)}::jsonb, ${Date.now()})
  `;
  await sql`
    delete from qingran_memory_log
    where id in (
      select id from qingran_memory_log
      order by created_at desc
      offset 400
    )
  `;
}

export async function loadRetrievable(): Promise<Retrievable[]> {
  const [l1, l2, l3] = await Promise.all([loadL1(), loadL2(), loadL3()]);
  return [
    ...l1.map((item) => ({
      id: item.id,
      layer: "l1" as const,
      text: item.text,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      status: "active" as const,
    })),
    ...l2.map((item) => ({
      id: item.id,
      layer: "l2" as const,
      text: item.text,
      startedAt: item.periodStart,
      endedAt: item.periodEnd,
      status: "active" as const,
    })),
    ...l3.map((item) => ({
      id: item.id,
      layer: "l3" as const,
      text: item.text,
      startedAt: item.createdAt,
      endedAt: item.lastEvidenceAt,
      status: item.status,
    })),
  ];
}

export async function loadBoard(): Promise<MemoryBoard> {
  const [portrait, openEvent, l1, l2, l3] = await Promise.all([
    loadPortrait(),
    loadOpenEvent(),
    loadL1(),
    loadL2(),
    loadL3(),
  ]);
  const items: MemoryItem[] = [
    ...l3.map((item) => ({
      id: item.id,
      layer: "l3" as const,
      text: item.text,
      startedAt: item.lastEvidenceAt,
      status: item.status,
    })),
    ...l2.map((item) => ({
      id: item.id,
      layer: "l2" as const,
      text: item.text,
      startedAt: item.periodStart,
      endedAt: item.periodEnd,
    })),
    ...l1.map((item) => ({
      id: item.id,
      layer: "l1" as const,
      text: item.text,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
    })),
  ];
  return { portrait, openEvent, items };
}

export async function updateMemoryItem(
  id: string,
  layer: MemoryItem["layer"],
  text: string,
): Promise<void> {
  const sql = await getSql();
  const body = text.replace(/\s+/g, " ").trim().slice(0, 600);
  if (layer === "l1") {
    if (!body) {
      await sql`delete from qingran_l1 where id = ${id}`;
      return;
    }
    await sql`update qingran_l1 set text = ${body} where id = ${id}`;
    return;
  }
  if (layer === "l2") {
    if (!body) {
      await sql`delete from qingran_l2 where id = ${id}`;
      return;
    }
    await sql`update qingran_l2 set text = ${body} where id = ${id}`;
    return;
  }
  if (!body) {
    await sql`delete from qingran_l3 where id = ${id}`;
    return;
  }
  await sql`update qingran_l3 set text = ${body}, updated_at = ${Date.now()} where id = ${id}`;
}

export async function deleteMemoryItem(id: string, layer: MemoryItem["layer"]): Promise<void> {
  const sql = await getSql();
  if (layer === "l1") await sql`delete from qingran_l1 where id = ${id}`;
  else if (layer === "l2") await sql`delete from qingran_l2 where id = ${id}`;
  else await sql`delete from qingran_l3 where id = ${id}`;
}

export function decodeStoredMessage(row: {
  id: string;
  role: ChatMessage["role"];
  body: string;
  created_at: number;
  scanned?: boolean;
}): ChatMessage {
  let text = row.body;
  let scanned = Boolean(row.scanned);
  let kind: MessageKind | undefined;
  if (text.startsWith("⟦已扫⟧")) {
    scanned = true;
    text = text.slice(4);
  }
  if (text.startsWith("⟦走向⟧")) {
    kind = "steer";
    text = text.slice(4);
  } else if (text.startsWith("⟦设定⟧")) {
    kind = "setting";
    text = text.slice(4);
  }
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    text,
    createdAt: Number(row.created_at),
    kind,
    scanned: scanned || undefined,
  };
}

export function encodeStoredMessage(msg: ChatMessage): string {
  let text = msg.text;
  if (msg.kind === "steer") text = `⟦走向⟧${text}`;
  else if (msg.kind === "setting") text = `⟦设定⟧${text}`;
  return text;
}

export function withCursor(messages: ChatMessage[], cursor: string): ChatMessage[] {
  return applyMemoryCursor(messages, cursor);
}

function similarText(a: string, b: string): boolean {
  const na = a.replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, "").toLowerCase();
  const nb = b.replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, "").toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function parseLooseTime(raw: string, fallback: number): number {
  if (!raw.trim()) return fallback;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

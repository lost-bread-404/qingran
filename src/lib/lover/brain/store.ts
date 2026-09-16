import { getSql, type Sql } from "../../db.ts";
import { newId } from "../storage.ts";
import { HISTORY_WINDOW, INDEX_MAX_ITEMS, SESSION_GAP_MS } from "./config.ts";
import { now } from "./clock.ts";
import { localDay, sessionIdFor, shiftDay } from "./time.ts";
import { similar } from "./text.ts";
import type {
  BrainJob,
  BrainLogRow,
  BrainMeta,
  DayFactor,
  DayLog,
  Episode,
  Experiment,
  Factor,
  Finding,
  IndexItem,
  Intention,
  JobStatus,
  JobType,
  Lens,
  Mind,
  Note,
  NoteStatus,
  PortraitRow,
  StoredMessage,
  Subject,
  Theme,
} from "./types.ts";
import { EMPTY_META, EMPTY_MIND } from "./types.ts";

export { similar };

export function pgTextArray(values: string[]): string {
  const escaped = values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

export function fromPgArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value == null) return [];
  if (typeof value === "string") {
    const t = value.trim();
    if (!t || t === "{}") return [];
    if (t.startsWith("{") && t.endsWith("}")) {
      const inner = t.slice(1, -1);
      if (!inner) return [];
      const out: string[] = [];
      let cur = "";
      let inQuote = false;
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i]!;
        const prev = inner[i - 1];
        if (ch === '"' && prev !== "\\") {
          inQuote = !inQuote;
          continue;
        }
        if (ch === "," && !inQuote) {
          out.push(unescapePg(cur));
          cur = "";
          continue;
        }
        cur += ch;
      }
      out.push(unescapePg(cur));
      return out.filter((s) => s.length > 0);
    }
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function unescapePg(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function asInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asIntOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function rowNote(r: Record<string, unknown>): Note {
  return {
    id: String(r.id),
    text: String(r.text ?? ""),
    tags: fromPgArray(r.tags),
    subject: (r.subject as Subject) || "rosie",
    lens: fromPgArray(r.lens) as Lens[],
    fromRosie: asBool(r.from_rosie),
    weight: asInt(r.weight, 3),
    status: (r.status as NoteStatus) || "active",
    supersededBy: r.superseded_by ? String(r.superseded_by) : null,
    links: fromPgArray(r.links),
    happenedAt: asInt(r.happened_at),
    localDay: String(r.local_day ?? ""),
    sourceIds: fromPgArray(r.source_ids),
    recallCount: asInt(r.recall_count),
    lastRecalledAt: asIntOrNull(r.last_recalled_at),
    createdAt: asInt(r.created_at),
    updatedAt: asInt(r.updated_at),
  };
}

export async function sql(): Promise<Sql> {
  return getSql();
}

export async function getMeta(): Promise<BrainMeta> {
  const db = await getSql();
  const rows = await db.query<{ data: unknown }>("select data from brain_meta where id = 1");
  const data = asJson<Partial<BrainMeta>>(rows[0]?.data, {});
  return { ...EMPTY_META, ...data };
}

export async function patchMeta(patch: Partial<BrainMeta>): Promise<BrainMeta> {
  const current = await getMeta();
  const next = { ...current, ...patch };
  const db = await getSql();
  await db.query("update brain_meta set data = $1::jsonb where id = 1", [JSON.stringify(next)]);
  return next;
}

export async function bumpNotesVersion(): Promise<number> {
  const meta = await getMeta();
  const next = meta.notesVersion + 1;
  await patchMeta({ notesVersion: next });
  return next;
}

export async function getMind(): Promise<Mind> {
  const db = await getSql();
  const rows = await db.query<{ data: unknown; turn_seq: unknown }>(
    "select data, turn_seq from qr_mind where id = 1",
  );
  const data = asJson<Partial<Mind>>(rows[0]?.data, {});
  return { ...EMPTY_MIND, ...data, turn_seq: asInt(rows[0]?.turn_seq, data.turn_seq ?? 0) };
}

export async function saveMind(mind: Mind, expectedTurn: number): Promise<boolean> {
  const db = await getSql();
  const rows = await db.query<{ id: number }>(
    `update qr_mind
     set data = $1::jsonb, turn_seq = $2, updated_at = $3
     where id = 1 and turn_seq < $2
     returning id`,
    [JSON.stringify(mind), expectedTurn, now()],
  );
  return rows.length > 0;
}

export async function resetMind(): Promise<void> {
  const db = await getSql();
  await db.query(
    "update qr_mind set data = '{}'::jsonb, turn_seq = 0, updated_at = $1 where id = 1",
    [now()],
  );
}

function rowMessage(r: Record<string, unknown>): StoredMessage {
  return {
    id: String(r.id),
    role: r.role === "assistant" ? "assistant" : "user",
    text: String(r.body ?? ""),
    createdAt: asInt(r.created_at),
    kind: r.kind === "steer" || r.kind === "setting" ? r.kind : "say",
    archivedAt: asIntOrNull(r.archived_at),
    sessionId: r.session_id ? String(r.session_id) : null,
    localDay: r.local_day ? String(r.local_day) : null,
  };
}

export async function listRecentMessages(limit = 240): Promise<StoredMessage[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     order by created_at desc, id desc
     limit $1`,
    [limit],
  );
  return rows.map(rowMessage).reverse();
}

export async function listHistoryWindow(
  excludeId: string | null,
  limit = HISTORY_WINDOW,
): Promise<StoredMessage[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where ($1::text is null or id <> $1)
     order by created_at desc, id desc
     limit $2`,
    [excludeId, limit],
  );
  return rows.map(rowMessage).reverse();
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages where id = $1`,
    [id],
  );
  return rows[0] ? rowMessage(rows[0]) : null;
}

export async function listMessagesByIds(ids: string[]): Promise<StoredMessage[]> {
  if (!ids.length) return [];
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages where id = any($1::text[])`,
    [pgTextArray(ids)],
  );
  const map = new Map(rows.map((r) => [String(r.id), rowMessage(r)]));
  return ids.map((id) => map.get(id)).filter((m): m is StoredMessage => Boolean(m));
}

export async function lastMessage(): Promise<StoredMessage | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     order by created_at desc, id desc
     limit 1`,
  );
  return rows[0] ? rowMessage(rows[0]) : null;
}

export async function lastMessageBefore(createdAt: number): Promise<StoredMessage | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where created_at < $1
     order by created_at desc, id desc
     limit 1`,
    [createdAt],
  );
  return rows[0] ? rowMessage(rows[0]) : null;
}

export async function upsertMessage(msg: {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  kind?: StoredMessage["kind"];
  timeZone: string;
}): Promise<StoredMessage> {
  const db = await getSql();
  const prev = await lastMessage();
  const day = localDay(msg.createdAt, msg.timeZone);
  const sess = sessionIdFor(
    msg.createdAt,
    prev ? { createdAt: prev.createdAt, sessionId: prev.sessionId || `s:${prev.createdAt}` } : null,
    msg.timeZone,
  );
  const kind = msg.kind ?? "say";
  await db.query(
    `insert into qingran_messages (id, role, body, created_at, kind, session_id, local_day)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do update set
       body = excluded.body,
       kind = excluded.kind,
       session_id = coalesce(qingran_messages.session_id, excluded.session_id),
       local_day = coalesce(qingran_messages.local_day, excluded.local_day)`,
    [msg.id, msg.role, msg.text.slice(0, 4000), msg.createdAt, kind, sess, day],
  );
  return {
    id: msg.id,
    role: msg.role,
    text: msg.text,
    createdAt: msg.createdAt,
    kind,
    archivedAt: null,
    sessionId: sess,
    localDay: day,
  };
}

export async function unarchivedOverflow(limit: number): Promise<StoredMessage[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where archived_at is null
       and id not in (
         select id from qingran_messages
         order by created_at desc, id desc
         limit $1
       )
     order by created_at asc, id asc
     limit $2`,
    [HISTORY_WINDOW, limit],
  );
  return rows.map(rowMessage);
}

export async function unarchivedForSession(sessionId: string): Promise<StoredMessage[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where session_id = $1 and archived_at is null
     order by created_at asc, id asc`,
    [sessionId],
  );
  return rows.map(rowMessage);
}

export async function unarchivedForDay(day: string): Promise<StoredMessage[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where local_day = $1 and archived_at is null
     order by created_at asc, id asc`,
    [day],
  );
  return rows.map(rowMessage);
}

export async function markArchived(ids: string[], at: number): Promise<void> {
  if (!ids.length) return;
  const db = await getSql();
  await db.query(
    `update qingran_messages set archived_at = $2
     where id = any($1::text[]) and archived_at is null`,
    [pgTextArray(ids), at],
  );
}

export async function messagesOnDay(day: string): Promise<StoredMessage[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where local_day = $1
     order by created_at asc, id asc`,
    [day],
  );
  return rows.map(rowMessage);
}

async function writeHistory(
  table: string,
  rowId: string,
  op: string,
  before: unknown,
  after: unknown,
  jobId?: string,
) {
  const db = await getSql();
  await db.query(
    `insert into mem_history (table_name, row_id, op, before, after, job_id, at)
     values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
    [table, rowId, op, JSON.stringify(before ?? null), JSON.stringify(after ?? null), jobId ?? null, now()],
  );
}

export async function upsertNote(
  note: Note,
  jobId?: string,
  op: string = "ADD",
  batch?: { key: string; supersedes?: string | null },
): Promise<void> {
  const db = await getSql();
  const existing = await getNote(note.id);
  await db.query(
    `insert into mem_notes (
       id, text, tags, subject, lens, from_rosie, weight, status, superseded_by, links,
       happened_at, local_day, source_ids, recall_count, last_recalled_at, created_at, updated_at
     ) values (
       $1,$2,$3::text[],$4,$5::text[],$6,$7,$8,$9,$10::text[],
       $11,$12,$13::text[],$14,$15,$16,$17
     )
     on conflict (id) do update set
       text = excluded.text, tags = excluded.tags, subject = excluded.subject, lens = excluded.lens,
       from_rosie = excluded.from_rosie, weight = excluded.weight, status = excluded.status,
       superseded_by = excluded.superseded_by, links = excluded.links, happened_at = excluded.happened_at,
       local_day = excluded.local_day, source_ids = excluded.source_ids, updated_at = excluded.updated_at`,
    [
      note.id, note.text, pgTextArray(note.tags), note.subject, pgTextArray(note.lens),
      note.fromRosie, note.weight, note.status, note.supersededBy, pgTextArray(note.links),
      note.happenedAt, note.localDay, pgTextArray(note.sourceIds), note.recallCount,
      note.lastRecalledAt, note.createdAt, note.updatedAt,
    ],
  );
  if (batch) {
    await db.query(`update mem_notes set batch_key = $2, supersedes = $3 where id = $1`, [
      note.id,
      batch.key,
      batch.supersedes ?? null,
    ]);
  }
  await writeHistory("mem_notes", note.id, op, existing, note, jobId);
}

/** 放弃某批次之前失败留下的 pending notes（重试前调用）。 */
export async function abandonPendingBatch(batchKey: string): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ id: string }>(
    `update mem_notes set status = 'archived', updated_at = $2
     where batch_key = $1 and status = 'pending' returning id`,
    [batchKey, now()],
  );
  return rows.length;
}

/**
 * 原子提交一个 archive 批次：单条 SQL 语句内完成
 * 消息标记已归档 + 旧 note supersede + pending note 生效。
 * 返回被 supersede 的 (旧 id, 新 id) 列表，用于事后写 history。
 */
export async function commitArchiveBatch(
  batchKey: string,
  messageIds: string[],
  at: number,
): Promise<Array<{ oldId: string; newId: string }>> {
  const db = await getSql();
  const rows = await db.query<{ kind: string; old_id: string | null; new_id: string | null }>(
    `with msgs as (
       update qingran_messages set archived_at = $2
       where id = any($1::text[]) and archived_at is null
       returning id
     ),
     sup as (
       update mem_notes o
       set status = 'superseded', superseded_by = n.id, updated_at = $2
       from mem_notes n
       where n.batch_key = $3 and n.status = 'pending'
         and n.supersedes = o.id and o.status = 'active'
       returning o.id as old_id, n.id as new_id
     ),
     act as (
       update mem_notes set status = 'active', updated_at = $2
       where batch_key = $3 and status = 'pending'
       returning id
     )
     select 'sup' as kind, old_id, new_id from sup
     union all select 'msg', null, null from (select count(*) from msgs) m
     union all select 'act', null, null from (select count(*) from act) a`,
    [pgTextArray(messageIds), at, batchKey],
  );
  return rows
    .filter((r) => r.kind === "sup" && r.old_id && r.new_id)
    .map((r) => ({ oldId: r.old_id!, newId: r.new_id! }));
}

export async function logSupersede(oldId: string, newIdValue: string, jobId?: string): Promise<void> {
  const existing = await getNote(oldId);
  if (!existing) return;
  await writeHistory(
    "mem_notes",
    oldId,
    "SUPERSEDE",
    { ...existing, status: "active", supersededBy: null },
    existing,
    jobId,
  );
}

export async function getNote(id: string): Promise<Note | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from mem_notes where id = $1", [id]);
  return rows[0] ? rowNote(rows[0]) : null;
}

export async function listNotesByIds(ids: string[]): Promise<Note[]> {
  if (!ids.length) return [];
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    "select * from mem_notes where id = any($1::text[])",
    [pgTextArray(ids)],
  );
  const map = new Map(rows.map((r) => [String(r.id), rowNote(r)]));
  return ids.map((id) => map.get(id)).filter((n): n is Note => Boolean(n));
}

export async function listActiveNotes(): Promise<Note[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    "select * from mem_notes where status = 'active' order by happened_at desc",
  );
  return rows.map(rowNote);
}

export async function listNotes(filter: {
  q?: string;
  subject?: Subject;
  tag?: string;
  fromDay?: string;
  toDay?: string;
  status?: NoteStatus;
  lens?: Lens;
  fromRosie?: boolean;
  limit?: number;
}): Promise<Note[]> {
  const db = await getSql();
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };
  if (filter.status) add("status = ?", filter.status);
  else {
    add("status <> ?", "archived");
    add("status <> ?", "pending");
  }
  if (filter.subject) add("subject = ?", filter.subject);
  if (filter.fromDay) add("local_day >= ?", filter.fromDay);
  if (filter.toDay) add("local_day <= ?", filter.toDay);
  if (filter.fromRosie != null) add("from_rosie = ?", filter.fromRosie);
  if (filter.lens) {
    params.push(filter.lens);
    where.push(`lens @> array[$${params.length}]::text[]`);
  }
  if (filter.tag) {
    params.push(filter.tag);
    where.push(`$${params.length} = any(tags)`);
  }
  if (filter.q) {
    params.push(`%${filter.q}%`);
    where.push(`text ilike $${params.length}`);
  }
  params.push(filter.limit ?? 200);
  const sqlText = `select * from mem_notes ${where.length ? `where ${where.join(" and ")}` : ""}
    order by happened_at desc, id desc limit $${params.length}`;
  const rows = await db.query<Record<string, unknown>>(sqlText, params);
  return rows.map(rowNote);
}

export async function notesForDay(day: string, diaryFromRosie = false): Promise<Note[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select * from mem_notes where local_day = $1 and status = 'active' order by happened_at asc`,
    [day],
  );
  const notes = rows.map(rowNote);
  if (!diaryFromRosie) return notes;
  return notes.filter((n) => n.fromRosie && n.lens.includes("diary"));
}

export async function heavyRecentNotes(days: number, minWeight: number): Promise<Note[]> {
  const db = await getSql();
  const cutoff = now() - days * 86_400_000;
  const rows = await db.query<Record<string, unknown>>(
    `select * from mem_notes
     where status = 'active' and weight >= $1 and happened_at >= $2
     order by weight desc, happened_at desc limit 50`,
    [minWeight, cutoff],
  );
  return rows.map(rowNote);
}

export async function supersedeNote(oldId: string, newIdValue: string, jobId?: string): Promise<void> {
  const existing = await getNote(oldId);
  if (!existing) return;
  const db = await getSql();
  await db.query(
    `update mem_notes set status = 'superseded', superseded_by = $2, updated_at = $3 where id = $1`,
    [oldId, newIdValue, now()],
  );
  await writeHistory(
    "mem_notes",
    oldId,
    "SUPERSEDE",
    existing,
    { ...existing, status: "superseded", supersededBy: newIdValue },
    jobId,
  );
}

export async function addLink(a: string, b: string): Promise<void> {
  if (!a || !b || a === b) return;
  const db = await getSql();
  for (const [from, to] of [[a, b], [b, a]] as const) {
    const note = await getNote(from);
    if (!note || note.links.includes(to)) continue;
    await db.query(`update mem_notes set links = $2::text[], updated_at = $3 where id = $1`, [
      from,
      pgTextArray([...note.links, to]),
      now(),
    ]);
  }
}

export async function bumpRecall(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await getSql();
  const ts = now();
  await db.query(
    `update mem_notes set recall_count = recall_count + 1, last_recalled_at = $2, updated_at = $2
     where id = any($1::text[])`,
    [pgTextArray(ids), ts],
  );
}

export async function listIndexNotes(): Promise<IndexItem[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(`select * from mem_notes where status = 'active'`);
  const ts = now();
  const items: IndexItem[] = [];
  for (const r of rows) {
    const n = rowNote(r);
    const bond = n.lens.includes("bond");
    if (!bond && !(n.subject === "rosie" && n.weight >= 3)) continue;
    const ageDays = Math.max(0, (ts - n.happenedAt) / 86_400_000);
    const score = n.weight + 2 * Math.exp(-ageDays / 14) + 0.5 * Math.min(n.recallCount, 4) + (bond ? 1 : 0);
    items.push({
      id: n.id, text: n.text, subject: n.subject, lens: n.lens, weight: n.weight,
      happenedAt: n.happenedAt, localDay: n.localDay, recallCount: n.recallCount, score,
    });
  }
  items.sort((a, b) => b.score - a.score);
  return items.slice(0, INDEX_MAX_ITEMS);
}

export async function listPortrait(): Promise<PortraitRow[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from qr_portrait order by last_seen desc");
  return rows.map((r) => ({
    id: String(r.id),
    topic: String(r.topic),
    body: String(r.body),
    status: r.status === "dormant" ? "dormant" : "active",
    evidenceIds: fromPgArray(r.evidence_ids),
    lastSeen: asInt(r.last_seen),
    updatedAt: asInt(r.updated_at),
  }));
}

export async function upsertPortrait(row: PortraitRow): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into qr_portrait (id, topic, body, status, evidence_ids, last_seen, updated_at)
     values ($1,$2,$3,$4,$5::text[],$6,$7)
     on conflict (id) do update set
       topic = excluded.topic, body = excluded.body, status = excluded.status,
       evidence_ids = excluded.evidence_ids, last_seen = excluded.last_seen, updated_at = excluded.updated_at`,
    [row.id, row.topic, row.body, row.status, pgTextArray(row.evidenceIds), row.lastSeen, row.updatedAt],
  );
}

export async function dormantOldPortrait(now: number): Promise<void> {
  const db = await getSql();
  await db.query(`update qr_portrait set status = 'dormant' where status = 'active' and last_seen < $1`, [
    now - 45 * 86_400_000,
  ]);
}

export function emptyDay(day: string): DayLog {
  return {
    day, summary: "", energy: null, mood: null, body: null, did: [], avoided: [], events: [], wins: [],
    firstActive: null, lastActive: null, msgCount: 0, coverage: "none", noteIds: [], version: 1, updatedAt: now(),
  };
}

function rowDay(r: Record<string, unknown>): DayLog {
  return {
    day: String(r.day),
    summary: String(r.summary ?? ""),
    energy: asIntOrNull(r.energy),
    mood: asIntOrNull(r.mood),
    body: r.body == null ? null : String(r.body),
    did: asJson(r.did, []),
    avoided: asJson(r.avoided, []),
    events: asJson(r.events, []),
    wins: asJson(r.wins, []),
    firstActive: asIntOrNull(r.first_active),
    lastActive: asIntOrNull(r.last_active),
    msgCount: asInt(r.msg_count),
    coverage: r.coverage === "ok" || r.coverage === "thin" ? r.coverage : "none",
    noteIds: fromPgArray(r.note_ids),
    version: asInt(r.version, 1),
    updatedAt: asInt(r.updated_at),
  };
}

export async function getDay(day: string): Promise<DayLog | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from diary_days where day = $1", [day]);
  return rows[0] ? rowDay(rows[0]) : null;
}

export async function listDays(fromDay: string, toDay: string): Promise<DayLog[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    "select * from diary_days where day >= $1 and day <= $2 order by day asc",
    [fromDay, toDay],
  );
  return rows.map(rowDay);
}

export async function upsertDay(day: DayLog): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into diary_days (
       day, summary, energy, mood, body, did, avoided, events, wins,
       first_active, last_active, msg_count, coverage, note_ids, version, updated_at
     ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14::text[],$15,$16)
     on conflict (day) do update set
       summary = excluded.summary, energy = excluded.energy, mood = excluded.mood, body = excluded.body,
       did = excluded.did, avoided = excluded.avoided, events = excluded.events, wins = excluded.wins,
       first_active = excluded.first_active, last_active = excluded.last_active, msg_count = excluded.msg_count,
       coverage = excluded.coverage, note_ids = excluded.note_ids, version = diary_days.version + 1,
       updated_at = excluded.updated_at`,
    [
      day.day, day.summary, day.energy, day.mood, day.body, JSON.stringify(day.did),
      JSON.stringify(day.avoided), JSON.stringify(day.events), JSON.stringify(day.wins),
      day.firstActive, day.lastActive, day.msgCount, day.coverage, pgTextArray(day.noteIds),
      day.version, day.updatedAt,
    ],
  );
}

function rowIntention(r: Record<string, unknown>): Intention {
  return {
    id: String(r.id),
    text: String(r.text),
    tag: r.tag == null ? null : String(r.tag),
    statedAt: asInt(r.stated_at),
    targetDay: r.target_day ? String(r.target_day) : null,
    status: (["open", "started", "done", "dropped"].includes(String(r.status)) ? r.status : "open") as Intention["status"],
    startedAt: asIntOrNull(r.started_at),
    doneAt: asIntOrNull(r.done_at),
    lastEvidenceAt: asInt(r.last_evidence_at),
    evidenceIds: fromPgArray(r.evidence_ids),
    updatedAt: asInt(r.updated_at),
  };
}

export async function listIntentions(filter?: { status?: string; tag?: string }): Promise<Intention[]> {
  const db = await getSql();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
  if (filter?.tag) { params.push(filter.tag); where.push(`tag = $${params.length}`); }
  const rows = await db.query<Record<string, unknown>>(
    `select * from diary_intentions ${where.length ? `where ${where.join(" and ")}` : ""} order by stated_at desc`,
    params,
  );
  return rows.map(rowIntention);
}

export async function openIntentions(): Promise<Intention[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select * from diary_intentions where status in ('open','started') order by stated_at asc`,
  );
  return rows.map(rowIntention);
}

export async function upsertIntention(row: Intention): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into diary_intentions (id, text, tag, stated_at, target_day, status, started_at, done_at, last_evidence_at, evidence_ids, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11)
     on conflict (id) do update set
       text = excluded.text, tag = excluded.tag, target_day = excluded.target_day, status = excluded.status,
       started_at = excluded.started_at, done_at = excluded.done_at, last_evidence_at = excluded.last_evidence_at,
       evidence_ids = excluded.evidence_ids, updated_at = excluded.updated_at`,
    [row.id, row.text, row.tag, row.statedAt, row.targetDay, row.status, row.startedAt, row.doneAt, row.lastEvidenceAt, pgTextArray(row.evidenceIds), row.updatedAt],
  );
}

function rowFactor(r: Record<string, unknown>): Factor {
  return {
    id: String(r.id),
    name: String(r.name),
    definition: String(r.definition),
    version: asInt(r.version, 1),
    isOutcome: asBool(r.is_outcome),
    status: r.status === "retired" ? "retired" : "active",
    origin: r.origin === "synth" || r.origin === "user" ? r.origin : "seed",
    userFeedback: r.user_feedback ? String(r.user_feedback) : null,
    createdAt: asInt(r.created_at),
    updatedAt: asInt(r.updated_at),
  };
}

export async function listFactors(activeOnly = true): Promise<Factor[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    activeOnly ? "select * from diary_factors where status = 'active' order by name" : "select * from diary_factors order by name",
  );
  return rows.map(rowFactor);
}

export async function getFactorByName(name: string): Promise<Factor | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from diary_factors where name = $1", [name]);
  return rows[0] ? rowFactor(rows[0]) : null;
}

export async function upsertFactor(row: Factor): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into diary_factors (id, name, definition, version, is_outcome, status, origin, user_feedback, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (id) do update set
       name = excluded.name, definition = excluded.definition, version = excluded.version,
       is_outcome = excluded.is_outcome, status = excluded.status, origin = excluded.origin,
       user_feedback = excluded.user_feedback, updated_at = excluded.updated_at`,
    [row.id, row.name, row.definition, row.version, row.isOutcome, row.status, row.origin, row.userFeedback, row.createdAt, row.updatedAt],
  );
}

export async function listDayFactors(fromDay?: string, toDay?: string): Promise<DayFactor[]> {
  const db = await getSql();
  const params: unknown[] = [];
  const where: string[] = [];
  if (fromDay) { params.push(fromDay); where.push(`day >= $${params.length}`); }
  if (toDay) { params.push(toDay); where.push(`day <= $${params.length}`); }
  const rows = await db.query<Record<string, unknown>>(
    `select * from diary_day_factors ${where.length ? `where ${where.join(" and ")}` : ""} order by day`,
    params,
  );
  return rows.map((r) => ({
    day: String(r.day),
    factorId: String(r.factor_id),
    version: asInt(r.version, 1),
    value: r.value == null ? null : asInt(r.value) === 1 ? 1 : 0,
    evidenceIds: fromPgArray(r.evidence_ids),
  }));
}

export async function upsertDayFactor(row: DayFactor): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into diary_day_factors (day, factor_id, version, value, evidence_ids)
     values ($1,$2,$3,$4,$5::text[])
     on conflict (day, factor_id) do update set version = excluded.version, value = excluded.value, evidence_ids = excluded.evidence_ids`,
    [row.day, row.factorId, row.version, row.value, pgTextArray(row.evidenceIds)],
  );
}

function rowTheme(r: Record<string, unknown>): Theme {
  return {
    id: String(r.id),
    name: String(r.name),
    definition: String(r.definition),
    version: asInt(r.version, 1),
    status: r.status === "merged" || r.status === "retired" ? r.status : "active",
    mergedInto: r.merged_into ? String(r.merged_into) : null,
    parentId: r.parent_id ? String(r.parent_id) : null,
    userFeedback: r.user_feedback ? String(r.user_feedback) : null,
    createdAt: asInt(r.created_at),
    updatedAt: asInt(r.updated_at),
  };
}

export async function listThemes(activeOnly = true): Promise<Theme[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    activeOnly ? "select * from diary_themes where status = 'active' order by name" : "select * from diary_themes order by name",
  );
  return rows.map(rowTheme);
}

export async function getTheme(id: string): Promise<Theme | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from diary_themes where id = $1", [id]);
  return rows[0] ? rowTheme(rows[0]) : null;
}

export async function upsertTheme(row: Theme): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into diary_themes (id, name, definition, version, status, merged_into, parent_id, user_feedback, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (id) do update set
       name = excluded.name, definition = excluded.definition, version = excluded.version, status = excluded.status,
       merged_into = excluded.merged_into, parent_id = excluded.parent_id, user_feedback = excluded.user_feedback, updated_at = excluded.updated_at`,
    [row.id, row.name, row.definition, row.version, row.status, row.mergedInto, row.parentId, row.userFeedback, row.createdAt, row.updatedAt],
  );
}

export async function addThemeMember(themeId: string, noteId: string, version: number): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into diary_theme_members (theme_id, note_id, version) values ($1,$2,$3)
     on conflict (theme_id, note_id) do update set version = excluded.version`,
    [themeId, noteId, version],
  );
}

export async function themeMemberCounts(): Promise<Record<string, number>> {
  const db = await getSql();
  const rows = await db.query<{ theme_id: string; n: number }>(
    "select theme_id, count(*)::int as n from diary_theme_members group by theme_id",
  );
  return Object.fromEntries(rows.map((r) => [r.theme_id, asInt(r.n)]));
}

export async function notesForTheme(themeId: string): Promise<Note[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select n.* from mem_notes n
     join diary_theme_members m on m.note_id = n.id
     where m.theme_id = $1
     order by n.happened_at desc`,
    [themeId],
  );
  return rows.map(rowNote);
}

export async function notesWithoutTheme(limit: number): Promise<Note[]> {
  const db = await getSql();
  const cutoffDay = shiftDay(localDay(now(), "UTC"), -60);
  const rows = await db.query<Record<string, unknown>>(
    `select n.* from mem_notes n
     where n.status = 'active' and n.from_rosie = true and 'diary' = any(n.lens)
       and n.local_day >= $1
       and not exists (select 1 from diary_theme_members m where m.note_id = n.id)
     order by n.happened_at desc limit $2`,
    [cutoffDay, limit],
  );
  return rows.map(rowNote);
}

export async function upsertThemeWeek(row: {
  themeId: string; week: string; mentions: number; actionTaken: number | null; moodAvg: number | null;
}): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into diary_theme_weeks (theme_id, week, mentions, action_taken, mood_avg)
     values ($1,$2,$3,$4,$5)
     on conflict (theme_id, week) do update set mentions = excluded.mentions, action_taken = excluded.action_taken, mood_avg = excluded.mood_avg`,
    [row.themeId, row.week, row.mentions, row.actionTaken, row.moodAvg],
  );
}

export async function listThemeWeeks(): Promise<Array<{
  themeId: string; week: string; mentions: number; actionTaken: number | null; moodAvg: number | null;
}>> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from diary_theme_weeks");
  return rows.map((r) => ({
    themeId: String(r.theme_id),
    week: String(r.week),
    mentions: asInt(r.mentions),
    actionTaken: asIntOrNull(r.action_taken),
    moodAvg: r.mood_avg == null ? null : Number(r.mood_avg),
  }));
}

export async function replaceEpisodes(rows: Episode[]): Promise<void> {
  const db = await getSql();
  for (const row of rows) {
    await db.query(
      `insert into diary_episodes (id, factor_id, start_day, end_day, end_known, days, evidence_ids, computed_at)
       values ($1,$2,$3,$4,$5,$6,$7::text[],$8)
       on conflict (id) do update set
         start_day = excluded.start_day, end_day = excluded.end_day, end_known = excluded.end_known,
         days = excluded.days, evidence_ids = excluded.evidence_ids, computed_at = excluded.computed_at`,
      [row.id, row.factorId, row.startDay, row.endDay, row.endKnown, row.days, pgTextArray(row.evidenceIds), row.computedAt],
    );
  }
}

export async function listEpisodes(): Promise<Episode[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from diary_episodes order by start_day");
  return rows.map((r) => ({
    id: String(r.id),
    factorId: String(r.factor_id),
    startDay: String(r.start_day),
    endDay: r.end_day ? String(r.end_day) : null,
    endKnown: asBool(r.end_known),
    days: asInt(r.days),
    evidenceIds: fromPgArray(r.evidence_ids),
    computedAt: asInt(r.computed_at),
  }));
}

export async function upsertFinding(row: Finding): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into diary_findings (
       id, kind, outcome_id, antecedent_id, lag, n11, n10, n01, n00, lift, score,
       example_days, counter_days, user_feedback, computed_at, tier
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],$13::text[],$14,$15,$16)
     on conflict (id) do update set
       n11 = excluded.n11, n10 = excluded.n10, n01 = excluded.n01, n00 = excluded.n00,
       lift = excluded.lift, score = excluded.score, example_days = excluded.example_days,
       counter_days = excluded.counter_days, computed_at = excluded.computed_at, tier = excluded.tier,
       user_feedback = coalesce(diary_findings.user_feedback, excluded.user_feedback)`,
    [
      row.id, row.kind, row.outcomeId, row.antecedentId, row.lag, row.n11, row.n10, row.n01, row.n00,
      row.lift, row.score, pgTextArray(row.exampleDays), pgTextArray(row.counterDays), row.userFeedback,
      row.computedAt, row.tier,
    ],
  );
}

export async function listFindings(): Promise<Finding[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from diary_findings order by score desc");
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind === "recovery" || r.kind === "cooccur" ? r.kind : "antecedent",
    outcomeId: String(r.outcome_id),
    antecedentId: String(r.antecedent_id),
    lag: asInt(r.lag),
    n11: asInt(r.n11), n10: asInt(r.n10), n01: asInt(r.n01), n00: asInt(r.n00),
    lift: Number(r.lift),
    score: Number(r.score),
    exampleDays: fromPgArray(r.example_days),
    counterDays: fromPgArray(r.counter_days),
    userFeedback: r.user_feedback ? String(r.user_feedback) : null,
    computedAt: asInt(r.computed_at),
    tier: r.tier === "clue" ? "clue" : "finding",
  }));
}

export async function setFindingFeedback(id: string, feedback: string | null): Promise<void> {
  const db = await getSql();
  await db.query("update diary_findings set user_feedback = $2 where id = $1", [id, feedback]);
}

export async function setThemeFeedback(id: string, feedback: string | null): Promise<void> {
  const db = await getSql();
  await db.query("update diary_themes set user_feedback = $2, updated_at = $3 where id = $1", [id, feedback, now()]);
}

export async function setFactorFeedback(id: string, feedback: string | null): Promise<void> {
  const db = await getSql();
  await db.query("update diary_factors set user_feedback = $2, updated_at = $3 where id = $1", [id, feedback, now()]);
}

export async function listExperiments(): Promise<Experiment[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from diary_experiments order by created_at desc");
  return rows.map((r) => ({
    id: String(r.id),
    hypothesis: String(r.hypothesis),
    action: String(r.action),
    outcomeId: String(r.outcome_id),
    complianceFactorId: r.compliance_factor_id ? String(r.compliance_factor_id) : null,
    startDay: String(r.start_day),
    endDay: String(r.end_day),
    status: String(r.status) as Experiment["status"],
    result: asJson<Experiment["result"]>(r.result, null),
    createdAt: asInt(r.created_at),
  }));
}

export async function upsertExperiment(row: Experiment): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into diary_experiments (id, hypothesis, action, outcome_id, compliance_factor_id, start_day, end_day, status, result, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
     on conflict (id) do update set
       hypothesis = excluded.hypothesis, action = excluded.action, outcome_id = excluded.outcome_id,
       compliance_factor_id = excluded.compliance_factor_id, start_day = excluded.start_day,
       end_day = excluded.end_day, status = excluded.status, result = excluded.result`,
    [row.id, row.hypothesis, row.action, row.outcomeId, row.complianceFactorId, row.startDay, row.endDay, row.status, JSON.stringify(row.result ?? null), row.createdAt],
  );
}

export async function upsertReport(row: {
  id: string; periodStart: string; periodEnd: string; data: unknown; narrative: string; createdAt: number;
}): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into diary_reports (id, period_start, period_end, data, narrative, created_at)
     values ($1,$2,$3,$4::jsonb,$5,$6)
     on conflict (id) do update set data = excluded.data, narrative = excluded.narrative`,
    [row.id, row.periodStart, row.periodEnd, JSON.stringify(row.data), row.narrative, row.createdAt],
  );
}

export async function listReports() {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from diary_reports order by period_start desc");
  return rows.map((r) => ({
    id: String(r.id),
    periodStart: String(r.period_start),
    periodEnd: String(r.period_end),
    data: asJson(r.data, {}),
    narrative: String(r.narrative ?? ""),
    createdAt: asInt(r.created_at),
  }));
}

export async function getReport(id: string) {
  const all = await listReports();
  return all.find((r) => r.id === id) ?? null;
}

function rowJob(r: Record<string, unknown>): BrainJob {
  return {
    id: String(r.id),
    type: r.type as JobType,
    dedupeKey: String(r.dedupe_key),
    payload: asJson(r.payload, {}),
    status: r.status as JobStatus,
    attempts: asInt(r.attempts),
    runAfter: asInt(r.run_after),
    lockedUntil: asIntOrNull(r.locked_until),
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: asInt(r.created_at),
    updatedAt: asInt(r.updated_at),
  };
}

export async function insertJob(job: BrainJob, force = false): Promise<boolean> {
  const db = await getSql();
  if (force) {
    await db.query(
      `insert into brain_jobs (id, type, dedupe_key, payload, status, attempts, run_after, created_at, updated_at)
       values ($1,$2,$3,$4::jsonb,'pending',0,$5,$6,$6)
       on conflict (dedupe_key) do update set
         status = 'pending', attempts = 0, run_after = excluded.run_after, last_error = null,
         payload = excluded.payload, updated_at = excluded.updated_at, locked_until = null`,
      [job.id, job.type, job.dedupeKey, JSON.stringify(job.payload), job.runAfter, job.createdAt],
    );
    return true;
  }
  const rows = await db.query<{ id: string }>(
    `insert into brain_jobs (id, type, dedupe_key, payload, status, attempts, run_after, created_at, updated_at)
     values ($1,$2,$3,$4::jsonb,'pending',0,$5,$6,$6)
     on conflict (dedupe_key) do nothing returning id`,
    [job.id, job.type, job.dedupeKey, JSON.stringify(job.payload), job.runAfter, job.createdAt],
  );
  return rows.length > 0;
}

export async function peekNextJob(at: number): Promise<BrainJob | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select * from brain_jobs
     where (status = 'pending' and run_after <= $1) or (status = 'running' and locked_until < $1)
     order by case type
       when 'reflect' then 0 when 'archive' then 1 when 'dusk' then 2
       when 'backfill' then 3 when 'synth' then 4 else 5 end, run_after
     limit 1`,
    [at],
  );
  return rows[0] ? rowJob(rows[0]) : null;
}

export async function countPendingJobs(): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from brain_jobs where status in ('pending','running')`,
  );
  return asInt(rows[0]?.n);
}

export async function listJobStatus(): Promise<{
  pending: number;
  running: number;
  pendingTypes: JobType[];
  runningTypes: JobType[];
  recent: Array<{ type: JobType; status: JobStatus; updatedAt: number; lastError: string | null }>;
}> {
  const db = await getSql();
  const counts = await db.query<{ status: string; type: string; n: number }>(
    `select status, type, count(*)::int as n
     from brain_jobs
     where status in ('pending','running')
     group by status, type`,
  );
  let pending = 0;
  let running = 0;
  const pendingTypes: JobType[] = [];
  const runningTypes: JobType[] = [];
  for (const row of counts) {
    const n = asInt(row.n);
    if (row.status === "running") {
      running += n;
      runningTypes.push(row.type as JobType);
    } else {
      pending += n;
      pendingTypes.push(row.type as JobType);
    }
  }
  const recentRows = await db.query<Record<string, unknown>>(
    `select type, status, updated_at, last_error from brain_jobs order by updated_at desc limit 10`,
  );
  return {
    pending,
    running,
    pendingTypes,
    runningTypes,
    recent: recentRows.map((r) => ({
      type: r.type as JobType,
      status: r.status as JobStatus,
      updatedAt: asInt(r.updated_at),
      lastError: r.last_error ? String(r.last_error) : null,
    })),
  };
}

export async function claimJob(nowMs: number, lockMs: number, preferId?: string): Promise<BrainJob | null> {
  const db = await getSql();
  if (preferId) {
    const updated = await db.query<Record<string, unknown>>(
      `update brain_jobs
       set status = 'running', locked_until = $2, attempts = attempts + 1, updated_at = $3
       where id = $1 and ((status = 'pending' and run_after <= $3) or (status = 'running' and locked_until < $3))
       returning *`,
      [preferId, nowMs + lockMs, nowMs],
    );
    return updated[0] ? rowJob(updated[0]) : null;
  }
  const candidates = await db.query<Record<string, unknown>>(
    `select * from brain_jobs
     where (status = 'pending' and run_after <= $1) or (status = 'running' and locked_until < $1)
     order by case type
       when 'reflect' then 0 when 'archive' then 1 when 'dusk' then 2
       when 'backfill' then 3 when 'synth' then 4 else 5 end, run_after
     limit 8`,
    [nowMs],
  );
  for (const row of candidates) {
    const job = rowJob(row);
    const updated = await db.query<Record<string, unknown>>(
      `update brain_jobs
       set status = 'running', locked_until = $2, attempts = attempts + 1, updated_at = $3
       where id = $1 and (status = 'pending' or locked_until < $3)
       returning *`,
      [job.id, nowMs + lockMs, nowMs],
    );
    if (updated[0]) return rowJob(updated[0]);
  }
  return null;
}

export async function finishJob(id: string, status: "done" | "failed" | "pending", extra?: {
  runAfter?: number; error?: string;
}): Promise<void> {
  const db = await getSql();
  await db.query(
    `update brain_jobs set status = $2, run_after = coalesce($3, run_after), last_error = $4, locked_until = null, updated_at = $5 where id = $1`,
    [id, status, extra?.runAfter ?? null, extra?.error ?? null, now()],
  );
}

export async function restoreClaim(id: string, attempts: number): Promise<void> {
  const db = await getSql();
  await db.query(
    `update brain_jobs
     set status = 'pending', locked_until = null, attempts = $2, updated_at = $3
     where id = $1`,
    [id, Math.max(0, attempts - 1), now()],
  );
}

export async function skipOldReflect(turnSeq: number): Promise<void> {
  const db = await getSql();
  await db.query(
    `update brain_jobs set status = 'done', locked_until = null, updated_at = $2
     where type = 'reflect' and status in ('pending','running')
       and coalesce((payload->>'turnSeq')::bigint, 0) < $1`,
    [turnSeq, now()],
  );
}

export async function newerReflectExists(turnSeq: number): Promise<boolean> {
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from brain_jobs
     where type = 'reflect' and status in ('pending','running')
       and coalesce((payload->>'turnSeq')::bigint, 0) > $1`,
    [turnSeq],
  );
  return asInt(rows[0]?.n) > 0;
}

export async function cleanupOldJobs(now: number): Promise<void> {
  const db = await getSql();
  await db.query(`delete from brain_jobs where status = 'done' and updated_at < $1`, [now - 14 * 86_400_000]);
}

export async function appendBrainLog(row: {
  jobId?: string | null; step: string; ok: boolean; ms?: number | null; inputChars?: number | null; raw?: string | null; note?: string | null;
}): Promise<void> {
  try {
    const db = await getSql();
    await db.query(
      `insert into brain_log (job_id, step, ok, ms, input_chars, raw, note, at) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.jobId ?? null, row.step, row.ok, row.ms ?? null, row.inputChars ?? null, (row.raw ?? "").slice(0, 4000), row.note ?? null, now()],
    );
  } catch {
    /* logging must never break talk */
  }
}

export async function listBrainLog(limit = 50): Promise<BrainLogRow[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from brain_log order by at desc, id desc limit $1", [limit]);
  return rows.map((r) => ({
    id: asInt(r.id),
    jobId: r.job_id ? String(r.job_id) : null,
    step: String(r.step),
    ok: asBool(r.ok),
    ms: asIntOrNull(r.ms),
    inputChars: asIntOrNull(r.input_chars),
    raw: r.raw ? String(r.raw) : null,
    note: r.note ? String(r.note) : null,
    at: asInt(r.at),
  }));
}

export async function getProfilePrompt(): Promise<string> {
  const db = await getSql();
  const rows = await db.query<{ data: unknown }>("select data from qingran_profile where id = 1");
  const data = asJson<Record<string, unknown>>(rows[0]?.data, {});
  const direct = typeof data.systemPrompt === "string" ? data.systemPrompt.trim() : "";
  return direct || "你就是清然。正在和 Rosie 语音通话。";
}

export { SESSION_GAP_MS, newId };

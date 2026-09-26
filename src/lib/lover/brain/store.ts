import { getSql, type Sql } from "../../db.ts";
import { NEUTRAL_PERSONA, storedSystemPrompt } from "../types.ts";
import { newId } from "../storage.ts";
import { collapseReplyVariants } from "../pair-messages.ts";
import { HISTORY_WINDOW, INDEX_MAX_ITEMS, SESSION_GAP_MS, clampHistoryWindow } from "./config.ts";
import { clipLogRecord } from "./log-clip.ts";
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
  InnerPlan,
  InnerState,
  LongingItem,
  Note,
  NoteStatus,
  PortraitKind,
  PortraitRow,
  PortraitStatus,
  StoredMessage,
  Subject,
  Theme,
} from "./types.ts";
import { EMPTY_INNER, EMPTY_META } from "./types.ts";
import { coerceMind } from "./mind-parse.ts";
import { portraitKindOf } from "./portrait-kind.ts";

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
    aliases: fromPgArray(r.aliases),
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
  const rows = await db.query<{ data: unknown; turn_seq: unknown; updated_at: unknown }>(
    "select data, turn_seq, updated_at from qr_mind where id = 1",
  );
  const data = asJson<Record<string, unknown>>(rows[0]?.data, {});
  return coerceMind(data, asInt(rows[0]?.turn_seq, 0), asInt(rows[0]?.updated_at, 0) || undefined);
}

export async function saveMind(mind: Mind, expectedTurn: number, meta?: { model?: string; ms?: number }): Promise<boolean> {
  const db = await getSql();
  const ts = now();
  const rows = await db.query<{ id: number }>(
    `update qr_mind
     set data = $1::jsonb, turn_seq = $2, updated_at = $3
     where id = 1 and turn_seq < $2
     returning id`,
    [JSON.stringify({ insight: mind.insight, memory_ids: mind.memory_ids }), expectedTurn, ts],
  );
  if (rows.length > 0) {
    try {
      const { appendMindHistory } = await import("./observability.ts");
      await appendMindHistory(expectedTurn, mind, meta?.model, meta?.ms);
    } catch {
      /* ignore */
    }
  }
  return rows.length > 0;
}

export async function resetMind(): Promise<void> {
  const db = await getSql();
  await db.query(
    "update qr_mind set data = '{}'::jsonb, turn_seq = 0, updated_at = $1 where id = 1",
    [now()],
  );
}

function parsePlans(raw: unknown): InnerPlan[] {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(value)) return [];
  const plans: InnerPlan[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const status = row.status === "done" || row.status === "dropped" ? row.status : "open";
    if (typeof row.id !== "string" || !row.id) continue;
    plans.push({
      id: row.id,
      what: typeof row.what === "string" ? row.what : "",
      why: typeof row.why === "string" ? row.why : "",
      trigger: typeof row.trigger === "string" ? row.trigger : undefined,
      expires_at: row.expires_at == null ? undefined : asInt(row.expires_at),
      status,
    });
  }
  return plans;
}

function parseLongings(raw: unknown, legacy: string): LongingItem[] {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  const items: LongingItem[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const text = typeof row.text === "string" ? row.text.trim() : "";
      if (!text) continue;
      items.push({
        id: typeof row.id === "string" && row.id ? row.id : `l${items.length + 1}`,
        text,
        since: typeof row.since === "string" ? row.since : "",
      });
    }
  }
  if (!items.length && legacy.trim()) return [{ id: "legacy", text: legacy.trim(), since: "" }];
  return items.slice(0, 5);
}

function rowToInner(row: Record<string, unknown> | undefined): InnerState {
  if (!row) return { ...EMPTY_INNER, plans: [], longings: [] };
  const longings = parseLongings(row.longings, String(row.longing ?? ""));
  return {
    desire: String(row.desire ?? ""),
    readHer: String(row.read_her ?? ""),
    feel: String(row.feel ?? ""),
    want: String(row.want ?? ""),
    choice: String(row.choice ?? ""),
    now: String(row.now_text ?? ""),
    scene: row.scene === "intimate" ? "intimate" : "daily",
    longing: longings.map((item) => item.text).join("；"),
    longings,
    plans: parsePlans(row.plans),
    glow: Number(row.glow ?? 0) || 0,
    glow_at: asInt(row.glow_at),
    turn_seq: asInt(row.turn_seq),
    updated_at: asInt(row.updated_at),
    longing_updated_at: asInt(row.longing_updated_at),
  };
}

export async function getInner(): Promise<InnerState> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select feel, desire, read_her, want, choice, now_text, scene, longing, longings, plans, glow, glow_at, turn_seq, updated_at, longing_updated_at
     from qr_inner where id = 1`,
  );
  return rowToInner(rows[0]);
}

export async function saveInnerPlans(plans: InnerPlan[]): Promise<void> {
  const db = await getSql();
  await db.query(`update qr_inner set plans = $1::jsonb where id = 1`, [JSON.stringify(plans)]);
}

export async function appendInnerLog(entry: {
  turnSeq: number;
  data: unknown;
  model?: string | null;
  ms?: number | null;
}): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into qr_inner_log (turn_seq, created_at, data, model, ms) values ($1,$2,$3::jsonb,$4,$5)`,
    [entry.turnSeq, now(), JSON.stringify(entry.data ?? {}), entry.model ?? null, entry.ms ?? null],
  );
}

export async function listInnerLogs(limit = 20): Promise<Array<{
  id: number;
  turnSeq: number;
  createdAt: number;
  data: import("./turn-trace.ts").JsonValue | null;
  model: string | null;
  ms: number | null;
}>> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, turn_seq, created_at, data, model, ms from qr_inner_log order by id desc limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    turnSeq: Number(row.turn_seq),
    createdAt: Number(row.created_at),
    data: row.data == null ? null : (JSON.parse(JSON.stringify(row.data)) as import("./turn-trace.ts").JsonValue),
    model: row.model ? String(row.model) : null,
    ms: row.ms == null ? null : Number(row.ms),
  }));
}

export async function saveInner(
  inner: InnerState,
  expectedTurn: number,
  meta?: { model?: string; ms?: number; log?: unknown },
): Promise<boolean> {
  const db = await getSql();
  const longings = inner.longings?.length
    ? inner.longings.slice(0, 5)
    : inner.longing.trim()
      ? [{ id: "legacy", text: inner.longing.trim(), since: "" }]
      : [];
  const rows = await db.query<{ id: number }>(
    `update qr_inner
     set feel = $1, desire = $2, read_her = $3, choice = $4, now_text = $5, scene = $6, longings = $7::jsonb, plans = $8::jsonb,
         turn_seq = $9, updated_at = $10, longing_updated_at = $11, glow = $12, glow_at = $13
     where id = 1 and turn_seq < $9
     returning id`,
    [
      inner.feel,
      inner.desire,
      inner.readHer,
      inner.choice,
      inner.now,
      inner.scene === "intimate" ? "intimate" : "daily",
      JSON.stringify(longings),
      JSON.stringify(inner.plans),
      expectedTurn,
      inner.updated_at,
      inner.longing_updated_at,
      inner.glow ?? 0,
      inner.glow_at ?? 0,
    ],
  );
  if (meta?.log !== undefined) {
    await appendInnerLog({
      turnSeq: expectedTurn,
      data: meta.log,
      model: meta.model,
      ms: meta.ms,
    });
  }
  return rows.length > 0;
}

/** Clear this turn's private fields. Longing and plans stay. */
export async function resetInnerTurn(): Promise<void> {
  const db = await getSql();
  await db.query(
    `update qr_inner
     set feel = '', desire = '', read_her = '', choice = '', now_text = '', scene = 'daily', turn_seq = 0, updated_at = $1
     where id = 1`,
    [now()],
  );
}

export async function getRoomClearedAt(): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ room_cleared_at: number | null }>(
    "select room_cleared_at from qingran_profile where id = 1",
  );
  return asInt(rows[0]?.room_cleared_at, 0);
}

export async function forgetUnarchivedMessages(at: number): Promise<number> {
  const db = await getSql();
  const dossier = await db.query<{ active: boolean; cursor_at: number }>(
    "select active, cursor_at from qr_dossier where id = 1",
  );
  const active = asBool(dossier[0]?.active);
  const cursor = Number(dossier[0]?.cursor_at ?? 0) || 0;
  if (active) {
    const rows = await db.query<{ n: number }>(
      `with u as (
         update qingran_messages
         set forgotten_at = $1
         where created_at > $2 and forgotten_at is null
         returning id
       ) select count(*)::int as n from u`,
      [at, cursor],
    );
    return asInt(rows[0]?.n);
  }
  const rows = await db.query<{ n: number }>(
    `with u as (
       update qingran_messages
       set forgotten_at = $1
       where archived_at is null and forgotten_at is null
       returning id
     ) select count(*)::int as n from u`,
    [at],
  );
  return asInt(rows[0]?.n);
}

export async function forgetAllMessages(at: number): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `with u as (
       update qingran_messages
       set forgotten_at = coalesce(forgotten_at, $1)
       where forgotten_at is null
       returning id
     ) select count(*)::int as n from u`,
    [at],
  );
  return asInt(rows[0]?.n);
}

export async function setRoomClearedAt(at: number): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into qingran_profile (id, data, room_cleared_at, updated_at)
     values (1, '{}'::jsonb, $1, now())
     on conflict (id) do update set room_cleared_at = excluded.room_cleared_at, updated_at = now()`,
    [at],
  );
}

/** Hide recent turns not yet folded into memory, from the screen and from Qingran; rows stay for analysis.
 * His heart is emptied (it may hold the stuck topic) and what he meant to do next is dropped.
 * Plans with a time (dinner, bedtime), plans she added, and the memory stay. */
export async function clearRecentConversation(): Promise<void> {
  const ts = now();
  const inner = await getInner();
  await setRoomClearedAt(ts);
  await forgetUnarchivedMessages(ts);
  await resetInnerTurn();
  const { dropUntimedPlans, setFocus } = await import("./heart.ts");
  await dropUntimedPlans();
  await setFocus("");
  await appendInnerLog({
    turnSeq: inner.turn_seq,
    data: { kind: "cleared_by_rosie" },
  });
}


function rowMessage(r: Record<string, unknown>): StoredMessage {
  return {
    id: String(r.id),
    role: r.role === "assistant" ? "assistant" : "user",
    text: String(r.body ?? ""),
    createdAt: asInt(r.created_at),
    kind:
      r.kind === "steer" || r.kind === "setting" || r.kind === "proactive" || r.kind === "system_notice"
        ? r.kind
        : "say",
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
     where created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
     order by created_at desc, id desc
     limit $1`,
    [limit],
  );
  return rows.map(rowMessage).reverse();
}

export async function listHistoryWindow(
  excludeId: string | null,
  limit = HISTORY_WINDOW,
  beforeCreatedAt: number | null = null,
): Promise<StoredMessage[]> {
  if (limit <= 0) return [];
  const db = await getSql();
  const fetchN = Math.min(limit + 32, 240);
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where ($1::text is null or id <> $1)
       and forgotten_at is null
       and kind is distinct from 'system_notice'
       and created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
       and ($3::bigint is null or created_at < $3)
     order by created_at desc, id desc
     limit $2`,
    [excludeId, fetchN, beforeCreatedAt],
  );
  return collapseReplyVariants(rows.map(rowMessage).reverse())
    .filter((message) => {
      if (!excludeId || message.role !== "assistant") return true;
      return !message.text.includes(`⟦回:${excludeId}⟧`);
    })
    .slice(-limit);
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
     where created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
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
       and created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
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
    [msg.id, msg.role, msg.text, msg.createdAt, kind, sess, day],
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

export async function updateMessageText(id: string, text: string, kind?: StoredMessage["kind"]): Promise<void> {
  const existing = await getMessage(id);
  const db = await getSql();
  const next = text;
  const ts = now();
  if (existing && existing.text !== next) {
    await db.query(
      `insert into qingran_message_edits (message_id, before, at) values ($1,$2,$3)`,
      [id, existing.text, ts],
    );
  }
  if (existing && existing.role === "user" && existing.text !== next) {
    // Same-sounding swaps she made by hand: candidates for the xAI keyterms, reviewed later in 听力.
    try {
      const { homophoneSwaps } = await import("../hearing/homophone-edits.ts");
      for (const swap of homophoneSwaps(existing.text, next)) {
        await db.query(
          `insert into qr_homophone_edits (at, message_id, wrong, correct, before, after) values ($1,$2,$3,$4,$5,$6)`,
          [ts, id, swap.wrong, swap.correct, existing.text.slice(0, 500), next.slice(0, 500)],
        );
      }
    } catch {
      // Never block an edit on this.
    }
  }
  if (kind) {
    await db.query(
      `update qingran_messages set body = $2, kind = $3, edited_at = $4 where id = $1`,
      [id, next, kind, ts],
    );
  } else {
    await db.query(`update qingran_messages set body = $2, edited_at = $3 where id = $1`, [id, next, ts]);
  }
}

export async function unarchivedOverflow(limit: number, historyWindow = HISTORY_WINDOW): Promise<StoredMessage[]> {
  const db = await getSql();
  const keep = clampHistoryWindow(historyWindow);
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where archived_at is null
       and forgotten_at is null
       and id not in (
         select id from qingran_messages
         order by created_at desc, id desc
         limit $1
       )
     order by created_at asc, id asc
     limit $2`,
    [keep, limit],
  );
  return rows.map(rowMessage);
}

export async function getStoredHistoryWindow(): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ data: unknown }>("select data from qingran_profile where id = 1");
  const data = asJson<Record<string, unknown>>(rows[0]?.data, {});
  return clampHistoryWindow(data.historyWindow);
}

export async function unarchivedForSession(sessionId: string): Promise<StoredMessage[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where session_id = $1 and archived_at is null and forgotten_at is null
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
     where local_day = $1 and archived_at is null and forgotten_at is null
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
     where local_day = $1 and forgotten_at is null
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
       id, text, tags, aliases, subject, lens, from_rosie, weight, status, superseded_by, links,
       happened_at, local_day, source_ids, recall_count, last_recalled_at, created_at, updated_at
     ) values (
       $1,$2,$3::text[],$4::text[],$5,$6::text[],$7,$8,$9,$10,$11::text[],
       $12,$13,$14::text[],$15,$16,$17,$18
     )
     on conflict (id) do update set
       text = excluded.text, tags = excluded.tags, aliases = excluded.aliases, subject = excluded.subject, lens = excluded.lens,
       from_rosie = excluded.from_rosie, weight = excluded.weight, status = excluded.status,
       superseded_by = excluded.superseded_by, links = excluded.links, happened_at = excluded.happened_at,
       local_day = excluded.local_day, source_ids = excluded.source_ids, updated_at = excluded.updated_at`,
    [
      note.id, note.text, pgTextArray(note.tags), pgTextArray(note.aliases ?? []), note.subject, pgTextArray(note.lens),
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
  statuses?: NoteStatus[];
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
  else if (filter.statuses?.length) {
    params.push(pgTextArray(filter.statuses));
    where.push(`status = any($${params.length}::text[])`);
  }
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
    `select * from mem_notes
     where local_day = $1 and status in ('active','superseded')
     order by happened_at asc`,
    [day],
  );
  const notes = rows.map(rowNote);
  if (!diaryFromRosie) return notes;
  return notes.filter((n) => n.fromRosie && n.lens.includes("diary"));
}

export async function firstMessageLocalDay(): Promise<string | null> {
  const db = await getSql();
  const rows = await db.query<{ d: string | null }>(
    `select min(local_day) as d from qingran_messages where local_day is not null and local_day <> ''`,
  );
  return rows[0]?.d ? String(rows[0].d) : null;
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
    const storySeed = n.sourceIds.includes("story");
    const recency = storySeed ? 0 : 2 * Math.exp(-ageDays / 14);
    const score = n.weight + recency + 0.5 * Math.min(n.recallCount, 4) + (bond ? 1 : 0);
    items.push({
      id: n.id, text: n.text, searchText: [n.text, ...n.tags, ...(n.aliases ?? [])].join(" "),
      subject: n.subject, lens: n.lens, weight: n.weight,
      happenedAt: n.happenedAt, localDay: n.localDay, recallCount: n.recallCount, score,
    });
  }
  items.sort((a, b) => b.score - a.score);
  return items.slice(0, INDEX_MAX_ITEMS);
}

export async function listPortrait(): Promise<PortraitRow[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from qr_portrait order by last_seen desc");
  return rows.map(rowPortrait);
}

export async function upsertPortrait(row: PortraitRow): Promise<void> {
  const db = await getSql();
  const kind = portraitKindOf(row);
  const lastSupportedAt = row.lastSupportedAt || row.updatedAt || row.lastSeen;
  const supportCount = row.supportCount >= 1 ? Math.round(row.supportCount) : 1;
  await db.query(
    `insert into qr_portrait (
       id, topic, body, status, kind, evidence_ids, last_seen, last_supported_at, support_count, updated_at
     )
     values ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10)
     on conflict (id) do update set
       topic = excluded.topic, body = excluded.body, status = excluded.status, kind = excluded.kind,
       evidence_ids = excluded.evidence_ids, last_seen = excluded.last_seen,
       last_supported_at = excluded.last_supported_at, support_count = excluded.support_count,
       updated_at = excluded.updated_at`,
    [
      row.id,
      row.topic,
      row.body,
      row.status,
      kind,
      pgTextArray(row.evidenceIds),
      row.lastSeen,
      lastSupportedAt,
      supportCount,
      row.updatedAt,
    ],
  );
}

export async function setPortraitStatus(id: string, status: PortraitStatus): Promise<void> {
  const db = await getSql();
  const next: PortraitStatus = status === "stale" || status === "superseded" ? status : "active";
  await db.query(`update qr_portrait set status = $2, updated_at = $3 where id = $1`, [id, next, now()]);
}

export async function deletePortrait(id: string): Promise<void> {
  const db = await getSql();
  await db.query(`delete from qr_portrait where id = $1`, [id]);
}

function rowPortrait(r: Record<string, unknown>): PortraitRow {
  const updatedAt = asInt(r.updated_at);
  const lastSeen = asInt(r.last_seen);
  const status: PortraitStatus =
    r.status === "stale" || r.status === "dormant"
      ? "stale"
      : r.status === "superseded"
        ? "superseded"
        : "active";
  return {
    id: String(r.id),
    topic: String(r.topic),
    body: String(r.body),
    status,
    kind: portraitKindOf({ id: String(r.id), topic: String(r.topic), kind: r.kind == null ? undefined : String(r.kind) }),
    evidenceIds: fromPgArray(r.evidence_ids),
    lastSeen,
    lastSupportedAt: asInt(r.last_supported_at) || updatedAt || lastSeen,
    supportCount: Math.max(1, asInt(r.support_count, 1)),
    updatedAt,
  };
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
     where n.status in ('active','superseded') and n.from_rosie = true and 'diary' = any(n.lens)
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

export async function deferJob(id: string, runAfter: number, error: string): Promise<void> {
  const db = await getSql();
  await db.query(
    `update brain_jobs
     set status = 'pending', run_after = $2, last_error = $3, locked_until = null, updated_at = $4
     where id = $1`,
    [id, runAfter, error, now()],
  );
}

export async function deferPendingUntil(runAfter: number, error: string): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `with u as (
       update brain_jobs
       set status = 'pending', run_after = $1, last_error = $2, locked_until = null, updated_at = $3
       where status in ('pending','running') and run_after <= $3
       returning id
     ) select count(*)::int as n from u`,
    [runAfter, error, now()],
  );
  return asInt(rows[0]?.n);
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
     where type = 'reflect' and status = 'pending'
       and coalesce((payload->>'turnSeq')::bigint, 0) < $1`,
    [turnSeq, now()],
  );
}

export const REFLECT_DEDUPE_KEY = "reflect";

export async function upsertReflectJob(turnSeq: number): Promise<void> {
  const db = await getSql();
  const ts = now();
  await db.query(
    `insert into brain_jobs (id, type, dedupe_key, payload, status, attempts, run_after, created_at, updated_at)
     values ($1, 'reflect', $2, $3::jsonb, 'pending', 0, $4, $4, $4)
     on conflict (dedupe_key) do update set
       payload = jsonb_build_object(
         'turnSeq', greatest(
           coalesce((brain_jobs.payload->>'turnSeq')::bigint, 0),
           (excluded.payload->>'turnSeq')::bigint
         )
       ),
       status = case when brain_jobs.status = 'running' then 'running' else 'pending' end,
       run_after = case when brain_jobs.status = 'running' then brain_jobs.run_after else excluded.run_after end,
       attempts = case when brain_jobs.status = 'running' then brain_jobs.attempts else 0 end,
       last_error = case when brain_jobs.status = 'running' then brain_jobs.last_error else null end,
       locked_until = case when brain_jobs.status = 'running' then brain_jobs.locked_until else null end,
       updated_at = excluded.updated_at`,
    [newId(), REFLECT_DEDUPE_KEY, JSON.stringify({ turnSeq }), ts],
  );
}

export async function reflectFollowUpSeq(jobId: string, ranSeq: number): Promise<number | null> {
  const db = await getSql();
  const rows = await db.query<{ seq: string | number | null }>(
    `select payload->>'turnSeq' as seq from brain_jobs where id = $1`,
    [jobId],
  );
  const latest = Number(rows[0]?.seq ?? 0);
  return Number.isFinite(latest) && latest > ranSeq ? latest : null;
}

export async function reopenReflectFollowUp(jobId: string): Promise<void> {
  const db = await getSql();
  await db.query(
    `update brain_jobs
     set status = 'pending', attempts = 0, run_after = $2, locked_until = null, last_error = null, updated_at = $2
     where id = $1`,
    [jobId, now()],
  );
}

/** Atomically done-or-reopen so a concurrent upsertReflectJob cannot lose a follow-up. */
export async function finishReflectJob(id: string, ranSeq: number): Promise<"pending" | "done"> {
  const db = await getSql();
  const ts = now();
  const rows = await db.query<{ status: string }>(
    `update brain_jobs
     set status = case
           when coalesce((payload->>'turnSeq')::bigint, 0) > $2 then 'pending'
           else 'done'
         end,
         attempts = case
           when coalesce((payload->>'turnSeq')::bigint, 0) > $2 then 0
           else attempts
         end,
         last_error = case
           when coalesce((payload->>'turnSeq')::bigint, 0) > $2 then null
           else last_error
         end,
         locked_until = null,
         run_after = $3,
         updated_at = $3
     where id = $1
     returning status`,
    [id, ranSeq, ts],
  );
  return rows[0]?.status === "pending" ? "pending" : "done";
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
  jobId?: string | null;
  step: string;
  ok: boolean;
  ms?: number | null;
  inputChars?: number | null;
  raw?: string | null;
  note?: string | null;
  route?: string | null;
  model?: string | null;
  effort?: string | null;
  turnSeq?: number | null;
  inputSystem?: string | null;
  inputUser?: string | null;
  outputText?: string | null;
  tokensIn?: number | null;
  tokensCached?: number | null;
  tokensOut?: number | null;
  tokensReasoning?: number | null;
  costUsd?: number | null;
  costUsdEst?: number | null;
  error?: string | null;
  codeVersion?: string | null;
  refs?: unknown;
  outputRef?: string | null;
  promptKey?: string | null;
  promptHash?: string | null;
  trimmed?: boolean;
}): Promise<number | null> {
  try {
    const clipped = clipLogRecord({
      inputSystem: row.inputSystem,
      inputUser: row.inputUser,
      outputText: row.outputText,
    });
    const db = await getSql();
    const rows = await db.query<{ id: number }>(
      `insert into brain_log (
         job_id, step, ok, ms, input_chars, raw, note, at,
         route, model, effort, turn_seq, input_system, input_user, output_text,
         tokens_in, tokens_cached, tokens_out, tokens_reasoning, cost_usd, error, trimmed,
         code_version, refs, output_ref, cost_usd_est, prompt_key, prompt_hash
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
         $23,$24::jsonb,$25,$26,$27,$28
       ) returning id`,
      [
        row.jobId ?? null,
        row.step,
        row.ok,
        row.ms ?? null,
        row.inputChars ?? null,
        (row.raw ?? "").slice(0, 4000),
        row.note ?? null,
        now(),
        row.route ?? null,
        row.model ?? null,
        row.effort ?? null,
        row.turnSeq ?? null,
        clipped.inputSystem,
        clipped.inputUser,
        clipped.outputText,
        row.tokensIn ?? null,
        row.tokensCached ?? null,
        row.tokensOut ?? null,
        row.tokensReasoning ?? null,
        row.costUsd ?? null,
        row.error ?? null,
        Boolean(row.trimmed) || clipped.truncated,
        row.codeVersion ?? null,
        row.refs == null ? null : JSON.stringify(row.refs),
        row.outputRef ?? null,
        row.costUsdEst ?? null,
        row.promptKey ?? null,
        row.promptHash ?? null,
      ],
    );
    return rows[0]?.id != null ? asInt(rows[0].id) : null;
  } catch {
    /* logging must never break talk */
    return null;
  }
}

export async function patchBrainLog(
  id: number | null | undefined,
  patch: { outputText?: string | null; outputRef?: string | null; note?: string | null },
): Promise<void> {
  if (!id) return;
  try {
    const db = await getSql();
    const sets: string[] = [];
    const params: unknown[] = [id];
    if ("outputText" in patch) {
      params.push(patch.outputText ?? null);
      sets.push(`output_text = $${params.length}`);
    }
    if ("outputRef" in patch) {
      params.push(patch.outputRef ?? null);
      sets.push(`output_ref = $${params.length}`);
    }
    if ("note" in patch && patch.note) {
      params.push(patch.note);
      sets.push(
        `note = case when coalesce(note, '') = '' then $${params.length} else note || E'\\n' || $${params.length} end`,
      );
    }
    if (!sets.length) return;
    await db.query(`update brain_log set ${sets.join(", ")} where id = $1`, params);
  } catch {
    /* ignore */
  }
}

export type VoiceModelStats = {
  model: string;
  n: number;
  avgMs: number | null;
  avgTtftMs: number | null;
  emptyRate: number | null;
};

function meanNums(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function parseLogTtftMs(note: string | null): number | null {
  if (!note) return null;
  const m = note.match(/ttft_ms=(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function isEmptyVoiceLog(row: { ok: boolean; note: string | null; error: string | null }): boolean {
  if (row.ok) return false;
  return /空回复|\bempty\b/.test(`${row.note ?? ""}\n${row.error ?? ""}`);
}

export async function voiceModelStatsLast7d(): Promise<VoiceModelStats[]> {
  const db = await getSql();
  const since = now() - 90 * 86_400_000;
  const rows = await db.query<{
    model: string | null;
    ms: unknown;
    ok: unknown;
    note: string | null;
    error: string | null;
  }>(`select model, ms, ok, note, error from brain_log where route = $1 and at >= $2`, ["voice", since]);
  const by = new Map<string, { n: number; ms: number[]; ttft: number[]; empty: number }>();
  for (const row of rows) {
    const model = (row.model ?? "").trim();
    if (!model) continue;
    let g = by.get(model);
    if (!g) {
      g = { n: 0, ms: [], ttft: [], empty: 0 };
      by.set(model, g);
    }
    g.n += 1;
    const ms = asIntOrNull(row.ms);
    if (ms != null) g.ms.push(ms);
    const ttft = parseLogTtftMs(row.note);
    if (ttft != null) g.ttft.push(ttft);
    if (isEmptyVoiceLog({ ok: asBool(row.ok), note: row.note, error: row.error })) g.empty += 1;
  }
  return [...by.entries()]
    .map(([model, g]) => ({
      model,
      n: g.n,
      avgMs: meanNums(g.ms),
      avgTtftMs: meanNums(g.ttft),
      emptyRate: g.n ? g.empty / g.n : null,
    }))
    .sort((a, b) => b.n - a.n || a.model.localeCompare(b.model));
}

export type BrainLogFilter = {
  route?: string | null;
  from?: number | null;
  to?: number | null;
};

export async function listBrainLog(limit = 50, filter?: BrainLogFilter): Promise<BrainLogRow[]> {
  const db = await getSql();
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter?.route) {
    params.push(filter.route);
    where.push(`(route = $${params.length} or step = $${params.length} or step like $${params.length} || ':%')`);
  }
  if (filter?.from != null) {
    params.push(filter.from);
    where.push(`at >= $${params.length}`);
  }
  if (filter?.to != null) {
    params.push(filter.to);
    where.push(`at <= $${params.length}`);
  }
  params.push(limit);
  const rows = await db.query<Record<string, unknown>>(
    `select id, job_id, step, ok, ms, input_chars,
            left(raw, 300) as raw, note, at, route, model, effort, turn_seq,
            tokens_in, tokens_cached, tokens_out, tokens_reasoning, cost_usd, error, trimmed,
            prompt_key, prompt_hash, left(output_text, 300) as output_text
     from brain_log
     ${where.length ? `where ${where.join(" and ")}` : ""}
     order by at desc, id desc
     limit $${params.length}`,
    params,
  );
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
    route: r.route ? String(r.route) : null,
    model: r.model ? String(r.model) : null,
    effort: r.effort ? String(r.effort) : null,
    turnSeq: asIntOrNull(r.turn_seq),
    tokensIn: asIntOrNull(r.tokens_in),
    tokensCached: asIntOrNull(r.tokens_cached),
    tokensOut: asIntOrNull(r.tokens_out),
    tokensReasoning: asIntOrNull(r.tokens_reasoning),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    error: r.error ? String(r.error) : null,
    trimmed: asBool(r.trimmed),
    promptKey: r.prompt_key ? String(r.prompt_key) : null,
    promptHash: r.prompt_hash ? String(r.prompt_hash) : null,
    outputText: r.output_text ? String(r.output_text) : null,
    inputSystem: r.input_system ? String(r.input_system) : null,
    inputUser: r.input_user ? String(r.input_user) : null,
  }));
}

export async function getProfileData(): Promise<unknown> {
  const db = await getSql();
  const rows = await db.query<{ data: unknown }>("select data from qingran_profile where id = 1");
  return rows[0]?.data ?? {};
}

export async function getProfilePrompt(): Promise<string> {
  const data = asJson<Record<string, unknown>>(await getProfileData(), {});
  const direct = storedSystemPrompt(data);
  if (direct) return direct;
  await warnPersonaMissing();
  return NEUTRAL_PERSONA;
}

async function warnPersonaMissing(): Promise<void> {
  try {
    await appendBrainLog({
      step: "persona_missing",
      ok: false,
      note: "persona_missing",
      error: "persona_missing",
    });
  } catch (err) {
    console.error("[persona] missing", err);
  }
}

export { SESSION_GAP_MS, newId };

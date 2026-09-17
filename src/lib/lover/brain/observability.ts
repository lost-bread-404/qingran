import { getSql } from "../../db.ts";
import { now } from "./clock.ts";
import { LOG_FULL_DAYS } from "./config.ts";

function textArray(values: string[]): string {
  const escaped = values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

export type BrainTurnRow = {
  turnSeq: number;
  userMsgId: string;
  replyMsgId?: string | null;
  localDay: string;
  sessionId?: string | null;
  mindTurnSeq?: number | null;
  mindAgeMs?: number | null;
  mindStale?: boolean;
  pickedIds?: string[];
  fallbackIds?: string[];
  careHint?: boolean;
  tail?: string | null;
  replyChars?: number | null;
  packMs?: number | null;
  dbFirstMs?: number | null;
  ttftMs?: number | null;
  firstAudioMs?: number | null;
  totalMs?: number | null;
  voiceModel?: string | null;
};

export async function insertBrainTurn(row: BrainTurnRow): Promise<void> {
  try {
    const db = await getSql();
    await db.query(
      `insert into brain_turns (
         turn_seq, user_msg_id, reply_msg_id, local_day, session_id,
         mind_turn_seq, mind_age_ms, mind_stale, picked_ids, fallback_ids, care_hint,
         tail, reply_chars, pack_ms, db_first_ms, ttft_ms, first_audio_ms, total_ms, voice_model, created_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::text[],$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
       )
       on conflict (turn_seq) do update set
         reply_msg_id = excluded.reply_msg_id,
         tail = excluded.tail,
         reply_chars = excluded.reply_chars,
         pack_ms = excluded.pack_ms,
         db_first_ms = excluded.db_first_ms,
         ttft_ms = excluded.ttft_ms,
         first_audio_ms = excluded.first_audio_ms,
         total_ms = excluded.total_ms,
         voice_model = excluded.voice_model`,
      [
        row.turnSeq,
        row.userMsgId,
        row.replyMsgId ?? null,
        row.localDay,
        row.sessionId ?? null,
        row.mindTurnSeq ?? null,
        row.mindAgeMs ?? null,
        Boolean(row.mindStale),
        textArray(row.pickedIds ?? []),
        textArray(row.fallbackIds ?? []),
        Boolean(row.careHint),
        row.tail ?? null,
        row.replyChars ?? null,
        row.packMs ?? null,
        row.dbFirstMs ?? null,
        row.ttftMs ?? null,
        row.firstAudioMs ?? null,
        row.totalMs ?? null,
        row.voiceModel ?? null,
        now(),
      ],
    );
  } catch {
    /* logging must never break talk */
  }
}

export async function fillReflectTurn(
  turnSeq: number,
  ok: boolean,
  ms: number,
  error?: string | null,
): Promise<void> {
  try {
    const db = await getSql();
    await db.query(
      `update brain_turns set reflect_ok = $2, reflect_ms = $3, reflect_error = $4
       where turn_seq = $1`,
      [turnSeq, ok, ms, error ?? null],
    );
  } catch {
    /* ignore */
  }
}

export async function appendMindHistory(
  turnSeq: number,
  data: unknown,
  model?: string | null,
  ms?: number | null,
): Promise<void> {
  try {
    const db = await getSql();
    await db.query(
      `insert into qr_mind_history (turn_seq, data, model, ms, created_at)
       values ($1, $2::jsonb, $3, $4, $5)
       on conflict (turn_seq) do nothing`,
      [turnSeq, JSON.stringify(data ?? {}), model ?? null, ms ?? null, now()],
    );
  } catch {
    /* ignore */
  }
}

export async function trimOldLogs(nowMs = now()): Promise<void> {
  const cutoff = nowMs - LOG_FULL_DAYS * 86_400_000;
  try {
    const db = await getSql();
    await db.query(
      `update brain_log
       set raw = left(coalesce(output_text, raw, ''), 500),
           input_system = null,
           input_user = null,
           output_text = null,
           trimmed = true
       where at < $1 and trimmed = false
         and (input_system is not null or input_user is not null or coalesce(length(output_text), 0) > 500)`,
      [cutoff],
    );
    await db.query(
      `update brain_turns
       set tail = left(tail, 500)
       where created_at < $1 and tail is not null and length(tail) > 500`,
      [cutoff],
    );
  } catch {
    /* ignore */
  }
}

export type ExportTable =
  | "brain_turns"
  | "brain_log"
  | "qr_mind_history"
  | "mem_history"
  | "brain_daily_digest"
  | "brain_jobs";

const EXPORT_SQL: Record<ExportTable, string> = {
  brain_turns: `select * from brain_turns where created_at >= $1 and created_at <= $2 and turn_seq > $3 order by turn_seq limit $4`,
  brain_log: `select * from brain_log where at >= $1 and at <= $2 and id > $3 order by id limit $4`,
  qr_mind_history: `select * from qr_mind_history where created_at >= $1 and created_at <= $2 and turn_seq > $3 order by turn_seq limit $4`,
  mem_history: `select * from mem_history where at >= $1 and at <= $2 and id > $3 order by id limit $4`,
  brain_daily_digest: `select * from brain_daily_digest where updated_at >= $1 and updated_at <= $2 and day > $3::text order by day limit $4`,
  brain_jobs: `select * from brain_jobs where created_at >= $1 and created_at <= $2 and id > $3::text order by id limit $4`,
};

function cursorOf(table: ExportTable, row: Record<string, unknown>): string {
  if (table === "brain_turns" || table === "qr_mind_history") return String(row.turn_seq ?? "0");
  if (table === "brain_daily_digest") return String(row.day ?? "");
  if (table === "brain_jobs") return String(row.id ?? "");
  return String(row.id ?? "0");
}

export async function exportLogPage(opts: {
  from: number;
  to: number;
  table?: ExportTable;
  cursor?: string;
  limit?: number;
}): Promise<{ table: ExportTable; rows: Record<string, unknown>[]; next: { table: ExportTable; cursor: string } | null }> {
  const tables: ExportTable[] = [
    "brain_turns",
    "brain_log",
    "qr_mind_history",
    "mem_history",
    "brain_daily_digest",
    "brain_jobs",
  ];
  const start = opts.table && tables.includes(opts.table) ? tables.indexOf(opts.table) : 0;
  const limit = Math.min(200, Math.max(1, opts.limit ?? 80));
  const db = await getSql();
  for (let i = start; i < tables.length; i++) {
    const table = tables[i]!;
    const cursor = i === start ? (opts.cursor ?? (table === "brain_daily_digest" || table === "brain_jobs" ? "" : "0")) : table === "brain_daily_digest" || table === "brain_jobs" ? "" : "0";
    const rows = await db.query<Record<string, unknown>>(EXPORT_SQL[table], [
      opts.from,
      opts.to,
      cursor,
      limit,
    ]);
    if (!rows.length) continue;
    const last = rows[rows.length - 1]!;
    const hasMore = rows.length >= limit;
    const nextTable = hasMore ? table : tables[i + 1];
    return {
      table,
      rows,
      next: nextTable
        ? { table: nextTable, cursor: hasMore ? cursorOf(table, last) : nextTable === "brain_daily_digest" || nextTable === "brain_jobs" ? "" : "0" }
        : null,
    };
  }
  return { table: "brain_jobs", rows: [], next: null };
}

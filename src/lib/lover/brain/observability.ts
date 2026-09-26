import { getSql } from "../../db.ts";
import { now } from "./clock.ts";

function textArray(values: string[]): string {
  const escaped = values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

function realArray(values: number[]): string {
  if (!values.length) return "{}";
  return `{${values.map((v) => (Number.isFinite(v) ? String(v) : "0")).join(",")}}`;
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
  queryIds?: string[];
  queryScores?: number[];
  jump?: boolean;
  jumpScore?: number | null;
  careHint?: boolean;
  tail?: string | null;
  replyChars?: number | null;
  packMs?: number | null;
  dbFirstMs?: number | null;
  ttftMs?: number | null;
  firstAudioMs?: number | null;
  totalMs?: number | null;
  voiceModel?: string | null;
  codeVersion?: string | null;
  charterHash?: string | null;
  longtermHash?: string | null;
  historyIds?: string[];
  clockText?: string | null;
};

export async function insertBrainTurn(row: BrainTurnRow): Promise<void> {
  try {
    const db = await getSql();
    await db.query(
      `insert into brain_turns (
         turn_seq, user_msg_id, reply_msg_id, local_day, session_id,
         mind_turn_seq, mind_age_ms, mind_stale, picked_ids, fallback_ids, care_hint,
         tail, reply_chars, pack_ms, db_first_ms, ttft_ms, first_audio_ms, total_ms, voice_model, created_at,
         code_version, charter_hash, longterm_hash, history_ids, clock_text,
         jump, jump_score, query_ids, query_scores
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::text[],$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
         $21,$22,$23,$24::text[],$25,
         $26,$27,$28::text[],$29::real[]
       )
       on conflict (turn_seq) do update set
         reply_msg_id = excluded.reply_msg_id,
         reply_chars = excluded.reply_chars,
         pack_ms = excluded.pack_ms,
         db_first_ms = excluded.db_first_ms,
         ttft_ms = excluded.ttft_ms,
         first_audio_ms = excluded.first_audio_ms,
         total_ms = excluded.total_ms,
         voice_model = excluded.voice_model,
         code_version = excluded.code_version,
         charter_hash = excluded.charter_hash,
         longterm_hash = excluded.longterm_hash,
         history_ids = excluded.history_ids,
         clock_text = excluded.clock_text,
         jump = excluded.jump,
         jump_score = excluded.jump_score,
         query_ids = excluded.query_ids,
         query_scores = excluded.query_scores,
         fallback_ids = excluded.fallback_ids,
         picked_ids = excluded.picked_ids`,
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
        textArray(row.queryIds ?? row.fallbackIds ?? []),
        Boolean(row.careHint),
        null,
        row.replyChars ?? null,
        row.packMs ?? null,
        row.dbFirstMs ?? null,
        row.ttftMs ?? null,
        row.firstAudioMs ?? null,
        row.totalMs ?? null,
        row.voiceModel ?? null,
        now(),
        row.codeVersion ?? null,
        row.charterHash ?? null,
        row.longtermHash ?? null,
        textArray(row.historyIds ?? []),
        row.clockText ?? null,
        Boolean(row.jump),
        row.jumpScore ?? null,
        textArray(row.queryIds ?? row.fallbackIds ?? []),
        realArray(row.queryScores ?? []),
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


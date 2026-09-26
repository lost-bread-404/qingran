import { getSql } from "../../db.ts";
import { gitCommitSha } from "../hearing/eval-meta.ts";
import { clampReplyDownTags, type ReplyDownTag } from "../reply-feedback.ts";
import { fromPgArray, pgTextArray } from "./store.ts";
import type { Heart } from "./heart.ts";

export const TRACE_FIELD_LIMIT = 100 * 1024;

export type RetrieveReason = "mind" | "keyword" | "fallback";

export type TraceRetrieveItem = {
  id: string;
  title: string;
  score: number | null;
  reason: RetrieveReason;
};

export type TurnTraceInput = {
  turnId: string;
  userMsgId?: string;
  turnSeq?: number;
  retrieve?: {
    selected?: string[];
    fallback?: string[];
    queryIds?: string[];
    queryScores?: number[];
    jump?: boolean;
    reasons?: RetrieveReason[];
    notes?: TraceRetrieveItem[];
  };
  reflector?: {
    mind?: unknown;
    model?: string | null;
    ms?: number | null;
  };
  live?: {
    notes?: string;
    historyCount?: number;
    promptHash?: string | null;
    model?: string | null;
    ms?: number | null;
    injectMoment?: boolean;
    injectDossier?: boolean;
    historyWindow?: number;
    injectLine?: string;
    intimateInjected?: boolean;
    personaPlacement?: "system" | "first_user";
    unexpected_state_block?: boolean;
    persona_missing?: boolean;
    inner?: { now: string; today: string };
    tool?: { name: string; arguments: string; ms: number } | null;
  };
  reply?: {
    text?: string;
    finishReason?: string | null;
    interrupted?: boolean;
  };
  commitSha?: string | null;
};

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TurnTraceRow = {
  turnId: string;
  userMsgId: string | null;
  turnSeq: number | null;
  createdAt: string;
  retrieve: JsonValue;
  reflector: JsonValue;
  live: JsonValue;
  reply: JsonValue;
  commitSha: string | null;
  truncated: boolean;
};

function asJsonText(value: unknown): { text: string; truncated: boolean } {
  if (value == null) return { text: "null", truncated: false };
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= TRACE_FIELD_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, TRACE_FIELD_LIMIT) + "…[truncated]", truncated: true };
}

export function clipTraceValue<T>(value: T): { value: T | string; truncated: boolean } {
  const { text, truncated } = asJsonText(value);
  if (!truncated) return { value, truncated: false };
  return { value: text, truncated: true };
}

export async function recordTurnTrace(input: TurnTraceInput): Promise<void> {
  try {
    const db = await getSql();
    const retrieve = input.retrieve ?? null;
    const packed = {
      retrieve: clipTraceValue(retrieve),
      reflector: clipTraceValue(input.reflector ?? null),
      live: clipTraceValue(input.live ?? null),
      reply: clipTraceValue(input.reply ?? null),
    };
    const truncated =
      packed.retrieve.truncated ||
      packed.reflector.truncated ||
      packed.live.truncated ||
      packed.reply.truncated;
    await db.query(
      `insert into turn_traces (
         turn_id, user_msg_id, turn_seq, retrieve, reflector, live, reply, commit_sha, truncated
       ) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)
       on conflict (turn_id) do update set
         user_msg_id = coalesce(excluded.user_msg_id, turn_traces.user_msg_id),
         turn_seq = coalesce(excluded.turn_seq, turn_traces.turn_seq),
         retrieve = coalesce(excluded.retrieve, turn_traces.retrieve),
         reflector = coalesce(excluded.reflector, turn_traces.reflector),
         live = coalesce(excluded.live, turn_traces.live),
         reply = case
           when excluded.reply is null then turn_traces.reply
           when jsonb_typeof(excluded.reply) <> 'object' then excluded.reply
           else jsonb_set(
             excluded.reply,
             '{interrupted}',
             to_jsonb(
               coalesce((turn_traces.reply->>'interrupted')::boolean, false)
               or coalesce((excluded.reply->>'interrupted')::boolean, false)
             )
           )
         end,
         commit_sha = coalesce(excluded.commit_sha, turn_traces.commit_sha),
         truncated = turn_traces.truncated or excluded.truncated`,
      [
        input.turnId,
        input.userMsgId ?? null,
        input.turnSeq ?? null,
        JSON.stringify(packed.retrieve.value),
        JSON.stringify(packed.reflector.value),
        JSON.stringify(packed.live.value),
        JSON.stringify(packed.reply.value),
        input.commitSha ?? (gitCommitSha() || null),
        truncated,
      ],
    );
  } catch (err) {
    console.error("[turn-trace] record failed", err);
  }
}

export async function patchTurnTraceReflector(opts: {
  turnSeq: number;
  inner: Heart | null;
  model?: string | null;
  ms?: number | null;
}): Promise<void> {
  try {
    const db = await getSql();
    const packed = clipTraceValue({
      inner: opts.inner,
      model: opts.model ?? null,
      ms: opts.ms ?? null,
    });
    const rows = await db.query<{ turn_id: string }>(
      `select turn_id from turn_traces where turn_seq = $1 order by created_at desc limit 1`,
      [opts.turnSeq],
    );
    if (rows[0]) {
      await db.query(
        `update turn_traces
         set reflector = $2::jsonb, truncated = truncated or $3
         where turn_id = $1`,
        [rows[0].turn_id, JSON.stringify(packed.value), packed.truncated],
      );
      return;
    }
    await db.query(
      `insert into turn_traces (turn_id, turn_seq, reflector, commit_sha, truncated)
       values ($1,$2,$3::jsonb,$4,$5)
       on conflict (turn_id) do update set
         reflector = excluded.reflector,
         truncated = turn_traces.truncated or excluded.truncated`,
      [
        `seq:${opts.turnSeq}`,
        opts.turnSeq,
        JSON.stringify(packed.value),
        gitCommitSha() || null,
        packed.truncated,
      ],
    );
  } catch (err) {
    console.error("[turn-trace] reflector patch failed", err);
  }
}

export async function markTurnInterrupted(turnId: string): Promise<void> {
  try {
    const db = await getSql();
    await db.query(
      `update turn_traces
       set reply = coalesce(reply, '{}'::jsonb) || jsonb_build_object('interrupted', true)
       where turn_id = $1`,
      [turnId],
    );
  } catch (err) {
    console.error("[turn-trace] interrupt patch failed", err);
  }
}

export type TurnFeedbackRow = {
  id: string;
  turnId: string | null;
  messageId: string;
  rating: "up" | "down";
  note: string;
  tags: ReplyDownTag[];
  createdAt: string;
  trace: TurnTraceRow | null;
};

export async function insertTurnFeedback(input: {
  id: string;
  turnId?: string | null;
  messageId: string;
  rating: "up" | "down";
  note: string;
  tags?: readonly string[];
}): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into turn_feedback (id, turn_id, message_id, rating, note, tags)
     values ($1,$2,$3,$4,$5,$6::text[])`,
    [input.id, input.turnId ?? null, input.messageId, input.rating, input.note, pgTextArray(clampReplyDownTags(input.tags))],
  );
}

export async function listTurnFeedback(limit = 200): Promise<TurnFeedbackRow[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select f.id, f.turn_id, f.message_id, f.rating, f.note, f.tags,
            f.created_at::text as created_at,
            t.user_msg_id, t.turn_seq, t.created_at::text as trace_created_at,
            t.retrieve, t.reflector, t.live, t.reply, t.commit_sha, t.truncated
     from turn_feedback f
     left join turn_traces t on t.turn_id = f.turn_id
     order by f.created_at desc
     limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    turnId: r.turn_id ? String(r.turn_id) : null,
    messageId: String(r.message_id),
    rating: r.rating === "up" ? "up" : "down",
    note: String(r.note ?? ""),
    tags: clampReplyDownTags(fromPgArray(r.tags)),
    createdAt: String(r.created_at ?? ""),
    trace: r.retrieve != null || r.reflector != null || r.live != null || r.reply != null || r.turn_id
      ? {
          turnId: String(r.turn_id ?? ""),
          userMsgId: r.user_msg_id ? String(r.user_msg_id) : null,
          turnSeq: r.turn_seq == null ? null : Number(r.turn_seq),
          createdAt: String(r.trace_created_at ?? r.created_at ?? ""),
          retrieve: (r.retrieve ?? null) as JsonValue,
          reflector: (r.reflector ?? null) as JsonValue,
          live: (r.live ?? null) as JsonValue,
          reply: (r.reply ?? null) as JsonValue,
          commitSha: r.commit_sha ? String(r.commit_sha) : null,
          truncated: Boolean(r.truncated),
        }
      : null,
  }));
}


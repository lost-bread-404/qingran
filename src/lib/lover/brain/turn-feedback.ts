import { getSql } from "../../db.ts";
import { decodeStoredBody } from "../message-markup.ts";
import { clampReplyDownTags, type ReplyDownTag } from "../reply-feedback.ts";
import { fromPgArray, pgTextArray } from "./store.ts";

/**
 * Her thumbs-up on a reply (docs/feedback.md). What that turn was given and recalled is in its brain_log row
 * (`output_ref = 'message:<reply id>'`, `refs.recalled`); the reply itself is the message.
 */
export type TurnFeedbackRow = {
  id: string;
  messageId: string;
  rating: "up" | "down";
  note: string;
  /** Only on old down-votes (the「差在哪」tags, before 2026-10-02). */
  tags: ReplyDownTag[];
  createdAt: string;
  reply: string;
  /** The moments that came back to him for that line (first 200 characters each). */
  recalled: string[];
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
    `select f.id, f.message_id, f.rating, f.note, f.tags, f.created_at::text as created_at,
            m.body as reply_body,
            (select l.refs->'recalled' from brain_log l
              where l.output_ref = 'message:' || f.message_id and l.route = 'voice'
              order by l.id desc limit 1) as recalled
     from turn_feedback f
     left join qingran_messages m on m.id = f.message_id
     order by f.created_at desc
     limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    messageId: String(r.message_id),
    rating: r.rating === "up" ? "up" : "down",
    note: String(r.note ?? ""),
    tags: clampReplyDownTags(fromPgArray(r.tags)),
    createdAt: String(r.created_at ?? ""),
    reply: r.reply_body ? decodeStoredBody(String(r.reply_body)).text : "",
    recalled: Array.isArray(r.recalled) ? r.recalled.map(String) : [],
  }));
}

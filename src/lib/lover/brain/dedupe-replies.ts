import { getSql } from "../../db.ts";
import { now } from "./clock.ts";
import { pgTextArray } from "./store.ts";

export type DupPair = { dropId: string; keepId: string };

const DUP_ASSISTANT_SQL = `
  select distinct on (m.id) m.id as drop_id, k.id as keep_id
  from qingran_messages m
  join qingran_messages k
    on k.role = 'assistant'
   and k.id <> m.id
   and k.session_id is not null
   and m.session_id is null
   and m.role = 'assistant'
   and abs(k.created_at - m.created_at) <= 5000
   and regexp_replace(k.body, '^⟦回:[^⟧]+⟧', '') = regexp_replace(m.body, '^⟦回:[^⟧]+⟧', '')
  order by m.id, abs(k.created_at - m.created_at), k.id
`;

export async function listDuplicateAssistantPairs(): Promise<DupPair[]> {
  const db = await getSql();
  const rows = await db.query<{ drop_id: string; keep_id: string }>(DUP_ASSISTANT_SQL);
  return rows.map((r) => ({ dropId: String(r.drop_id), keepId: String(r.keep_id) }));
}

export async function listDuplicateActiveNoteIds(): Promise<string[]> {
  const db = await getSql();
  const rows = await db.query<{ id: string }>(
    `select id from (
       select id, row_number() over (partition by text order by created_at, id) as rn
       from mem_notes
       where status = 'active'
     ) ranked
     where rn > 1
     order by id`,
  );
  return rows.map((r) => String(r.id));
}

async function rewriteMessageRefs(pairs: DupPair[]): Promise<void> {
  if (!pairs.length) return;
  const db = await getSql();
  for (const { dropId, keepId } of pairs) {
    await db.query(
      `update qingran_hearing_clips set reply_message_id = $2 where reply_message_id = $1`,
      [dropId, keepId],
    );
    await db.query(
      `update qingran_hearing_turns set reply_message_id = $2 where reply_message_id = $1`,
      [dropId, keepId],
    );
    await db.query(
      `update qingran_reply_flags set message_id = $2 where message_id = $1`,
      [dropId, keepId],
    );
    await db.query(
      `update turn_feedback set message_id = $2 where message_id = $1`,
      [dropId, keepId],
    );
    await db.query(
      `update brain_turns set reply_msg_id = $2 where reply_msg_id = $1`,
      [dropId, keepId],
    );
    await db.query(
      `update qingran_message_edits set message_id = $2 where message_id = $1`,
      [dropId, keepId],
    );
    await db.query(
      `update mem_notes
       set source_ids = (
         select coalesce(array_agg(distinct x), '{}')
         from (
           select case when s = $1 then $2 else s end as x
           from unnest(source_ids) as s
         ) t
       )
       where $1 = any(source_ids)`,
      [dropId, keepId],
    );
  }
}

export async function dedupeDuplicateAssistantReplies(): Promise<{ dropped: number; pairs: DupPair[] }> {
  const pairs = await listDuplicateAssistantPairs();
  if (!pairs.length) return { dropped: 0, pairs };
  await rewriteMessageRefs(pairs);
  const db = await getSql();
  await db.query(`delete from qingran_messages where id = any($1::text[])`, [
    pgTextArray(pairs.map((p) => p.dropId)),
  ]);
  return { dropped: pairs.length, pairs };
}

export async function dedupeActiveNotesByText(): Promise<{ archived: number; ids: string[] }> {
  const ids = await listDuplicateActiveNoteIds();
  if (!ids.length) return { archived: 0, ids };
  const db = await getSql();
  await db.query(
    `update mem_notes set status = 'archived', updated_at = $2 where id = any($1::text[]) and status = 'active'`,
    [pgTextArray(ids), now()],
  );
  return { archived: ids.length, ids };
}

-- One-shot: drop client-persisted duplicate assistant rows (no session_id)
-- when a server copy (with session_id) has the same body within 5s.
-- Rewrite refs, then archive active mem_notes that share identical text.

create table if not exists _dup_assistant_drop (
  drop_id text primary key,
  keep_id text not null
);

insert into _dup_assistant_drop (drop_id, keep_id)
select distinct on (m.id) m.id, k.id
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
on conflict (drop_id) do nothing;

update qingran_hearing_clips c
set reply_message_id = d.keep_id
from _dup_assistant_drop d
where c.reply_message_id = d.drop_id;

update qingran_hearing_turns t
set reply_message_id = d.keep_id
from _dup_assistant_drop d
where t.reply_message_id = d.drop_id;

update qingran_reply_flags f
set message_id = d.keep_id
from _dup_assistant_drop d
where f.message_id = d.drop_id;

update turn_feedback f
set message_id = d.keep_id
from _dup_assistant_drop d
where f.message_id = d.drop_id;

update brain_turns t
set reply_msg_id = d.keep_id
from _dup_assistant_drop d
where t.reply_msg_id = d.drop_id;

update qingran_message_edits e
set message_id = d.keep_id
from _dup_assistant_drop d
where e.message_id = d.drop_id;

update mem_notes n
set source_ids = (
  select coalesce(array_agg(distinct mapped.v), '{}')
  from (
    select case when d.keep_id is not null then d.keep_id else x end as v
    from unnest(n.source_ids) as x
    left join _dup_assistant_drop d on d.drop_id = x
  ) mapped
)
where exists (
  select 1 from unnest(n.source_ids) x
  join _dup_assistant_drop d on d.drop_id = x
);

delete from qingran_messages
where id in (select drop_id from _dup_assistant_drop);

drop table if exists _dup_assistant_drop;

update mem_notes n
set status = 'archived',
    updated_at = (extract(epoch from now()) * 1000)::bigint
from (
  select id
  from (
    select id,
           row_number() over (partition by text order by created_at, id) as rn
    from mem_notes
    where status = 'active'
  ) ranked
  where rn > 1
) extra
where n.id = extra.id
  and n.status = 'active';

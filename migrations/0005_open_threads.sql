-- 未完成事件可同时有多件；相关记忆的挑选结果存在 meta 里，供下一轮主通道使用。

create table if not exists qingran_open (
  id text primary key,
  started_at bigint not null,
  text text not null,
  updated_at bigint not null
);

insert into qingran_open (id, started_at, text, updated_at)
select 'open-legacy', started_at, draft, updated_at
from qingran_open_event
where coalesce(trim(draft), '') <> ''
on conflict (id) do nothing;

alter table qingran_memory_meta
  add column if not exists picked_ids jsonb not null default '[]'::jsonb;

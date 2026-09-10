-- 清然记忆系统：未闭合事件、L1/L2/L3、活画像、使用日志。
-- 不改宪章。旧 qingran_memories 一次导入为 L1，之后不再写入。

alter table qingran_messages
  add column if not exists scanned boolean not null default false;

update qingran_messages
  set scanned = true
  where scanned = false
    and body like '⟦已扫⟧%';

create table if not exists qingran_open_event (
  id integer primary key default 1 check (id = 1),
  started_at bigint not null,
  draft text not null default '',
  points text not null default '',
  updated_at bigint not null
);

create table if not exists qingran_l1 (
  id text primary key,
  started_at bigint not null,
  ended_at bigint not null,
  text text not null,
  created_at bigint not null
);

create index if not exists qingran_l1_ended_idx on qingran_l1 (ended_at desc);

create table if not exists qingran_l2 (
  id text primary key,
  period_start bigint not null,
  period_end bigint not null,
  text text not null,
  created_at bigint not null
);

create index if not exists qingran_l2_period_idx on qingran_l2 (period_end desc);

create table if not exists qingran_l3 (
  id text primary key,
  status text not null default 'active',
  text text not null,
  last_evidence_at bigint not null,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists qingran_portrait (
  id integer primary key default 1 check (id = 1),
  body text not null default '',
  updated_at bigint not null
);

create table if not exists qingran_memory_log (
  id text primary key,
  kind text not null,
  note text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at bigint not null
);

create index if not exists qingran_memory_log_created_idx
  on qingran_memory_log (created_at desc);

create table if not exists qingran_memory_meta (
  id integer primary key default 1 check (id = 1),
  last_interval_at bigint not null default 0,
  last_interval_day text not null default '',
  interval_retry_at bigint not null default 0,
  time_zone text not null default 'UTC'
);

insert into qingran_memory_meta (id)
values (1)
on conflict (id) do nothing;

insert into qingran_portrait (id, body, updated_at)
values (1, '', 0)
on conflict (id) do nothing;

insert into qingran_l1 (id, started_at, ended_at, text, created_at)
select id, created_at, updated_at, body, created_at
from qingran_memories
on conflict (id) do nothing;

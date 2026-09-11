-- Layered memory for 清然: events stay conservative; intimacy / open loops
-- / portrait / daily impressions make Rosie feel seen across calls.
-- Works on Neon and PGLite (no vector extension).

alter table qingran_messages
  add column if not exists kind text not null default 'say',
  add column if not exists scanned boolean not null default false,
  add column if not exists session_id text;

update qingran_messages
set scanned = true
where scanned = false and body like '⟦已扫⟧%';

update qingran_messages
set kind = 'steer'
where kind = 'say' and (body like '⟦走向⟧%' or body like '⟦已扫⟧⟦走向⟧%');

update qingran_messages
set kind = 'setting'
where kind = 'say' and (body like '⟦设定⟧%' or body like '⟦已扫⟧⟦设定⟧%');

alter table qingran_memories
  add column if not exists kind text not null default 'event',
  add column if not exists importance smallint not null default 5,
  add column if not exists confidence real not null default 0.7,
  add column if not exists status text not null default 'confirmed',
  add column if not exists valence real,
  add column if not exists last_recalled_at bigint,
  add column if not exists recall_count integer not null default 0,
  add column if not exists tags text[] not null default '{}',
  add column if not exists source_ids text[] not null default '{}';

create index if not exists qingran_memories_alive_idx
  on qingran_memories (status, kind, importance desc);

create table if not exists qingran_portrait (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into qingran_portrait (id, data)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

create table if not exists qingran_daily (
  day date primary key,
  impression text not null default '',
  open_loops jsonb not null default '[]'::jsonb,
  vocal_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

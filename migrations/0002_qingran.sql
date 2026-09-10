create table if not exists qingran_profile (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into qingran_profile (id, data)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

create table if not exists qingran_messages (
  id text primary key,
  role text not null,
  body text not null,
  created_at bigint not null
);

create index if not exists qingran_messages_created_idx
  on qingran_messages (created_at);

create table if not exists qingran_memories (
  id text primary key,
  body text not null,
  created_at bigint not null,
  updated_at bigint not null
);

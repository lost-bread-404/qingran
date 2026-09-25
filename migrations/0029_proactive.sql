alter table qingran_profile add column if not exists identity text not null default '';
alter table qingran_profile add column if not exists identity_updated_at bigint not null default 0;
alter table qingran_profile add column if not exists rhythm text not null default '';

create table if not exists qr_busy_periods (
  id text primary key,
  from_day text not null,
  to_day text not null,
  busy real not null,
  label text not null,
  reason text not null default '',
  identity_hash text not null,
  created_at bigint not null
);

alter table qr_inner add column if not exists glow real not null default 0;
alter table qr_inner add column if not exists glow_at bigint not null default 0;
alter table qr_inner add column if not exists longings jsonb not null default '[]'::jsonb;

update qr_inner
set longings = jsonb_build_array(jsonb_build_object(
  'id', 'legacy',
  'text', longing,
  'since', ''
))
where longing <> '' and longings = '[]'::jsonb;

create table if not exists qr_glow_events (
  id bigserial primary key,
  at bigint not null,
  delta real not null,
  why text not null,
  source text not null,
  turn_seq bigint,
  glow_after real not null
);

create table if not exists qr_reach (
  id int primary key default 1,
  next_at bigint,
  intent text not null default '',
  set_by text not null default '',
  set_at bigint not null default 0,
  enabled boolean not null default true,
  retry int not null default 0
);
insert into qr_reach (id) values (1) on conflict do nothing;

create table if not exists qr_reach_log (
  id bigserial primary key,
  at bigint not null,
  trigger text not null,
  intent text,
  called_llm boolean not null,
  sent boolean not null,
  message_id text,
  text text,
  push_result text,
  next_at bigint,
  next_intent text,
  model text,
  ms int
);

create table if not exists qr_push_devices (
  token text primary key,
  env text not null,
  created_at bigint not null,
  last_ok_at bigint,
  last_error text
);

create table if not exists qr_manual_edits (
  id bigserial primary key,
  at bigint not null,
  target text not null,
  before jsonb,
  after jsonb
);

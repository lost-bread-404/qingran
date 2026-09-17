create table if not exists qr_charter_versions (
  hash text primary key,
  text text not null,
  first_seen bigint not null,
  last_seen bigint not null
);

create table if not exists qr_block_snapshots (
  hash text primary key,
  kind text not null,
  text text not null,
  first_seen bigint not null,
  last_seen bigint not null
);
create index if not exists qr_block_snapshots_kind_idx on qr_block_snapshots (kind, last_seen);

create table if not exists qingran_message_edits (
  id bigserial primary key,
  message_id text not null,
  before text not null,
  at bigint not null
);
create index if not exists qingran_message_edits_msg_idx on qingran_message_edits (message_id, at);

alter table qingran_messages add column if not exists edited_at bigint;

alter table brain_log
  add column if not exists code_version text,
  add column if not exists refs jsonb,
  add column if not exists output_ref text,
  add column if not exists cost_usd_est real;

alter table brain_turns
  add column if not exists code_version text,
  add column if not exists charter_hash text,
  add column if not exists longterm_hash text,
  add column if not exists history_ids text[],
  add column if not exists clock_text text;

create table if not exists brain_log_raw (
  log_id bigint primary key,
  input jsonb not null,
  at bigint not null
);

alter table spend_events
  add column if not exists usd_est real,
  add column if not exists cost_source text;

create table if not exists spend_monthly (
  month text not null,
  route text not null,
  model text not null default '',
  usd real not null default 0,
  calls integer not null default 0,
  tokens_in bigint not null default 0,
  tokens_cached bigint not null default 0,
  tokens_out bigint not null default 0,
  primary key (month, route, model)
);

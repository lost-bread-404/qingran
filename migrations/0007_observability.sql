-- Observability + dusk intention-op idempotency.

create table if not exists diary_intention_ops (
  day text not null,
  op_hash text not null,
  applied_at bigint not null,
  primary key (day, op_hash)
);

alter table brain_log
  add column if not exists route text,
  add column if not exists model text,
  add column if not exists effort text,
  add column if not exists turn_seq bigint,
  add column if not exists input_system text,
  add column if not exists input_user text,
  add column if not exists output_text text,
  add column if not exists tokens_in integer,
  add column if not exists tokens_cached integer,
  add column if not exists tokens_out integer,
  add column if not exists tokens_reasoning integer,
  add column if not exists cost_usd real,
  add column if not exists error text,
  add column if not exists trimmed boolean not null default false;
create index if not exists brain_log_at_idx on brain_log (at);
create index if not exists brain_log_route_idx on brain_log (route, at);

create table if not exists brain_turns (
  turn_seq bigint primary key,
  user_msg_id text not null,
  reply_msg_id text,
  local_day text not null,
  session_id text,
  mind_turn_seq bigint,
  mind_age_ms bigint,
  mind_stale boolean not null default false,
  picked_ids text[] not null default '{}',
  fallback_ids text[] not null default '{}',
  care_hint boolean not null default false,
  tail text,
  reply_chars integer,
  pack_ms integer,
  db_first_ms integer,
  ttft_ms integer,
  first_audio_ms integer,
  total_ms integer,
  voice_model text,
  reflect_ok boolean,
  reflect_ms integer,
  reflect_error text,
  feedback text,
  created_at bigint not null
);
create index if not exists brain_turns_day_idx on brain_turns (local_day);

create table if not exists qr_mind_history (
  turn_seq bigint primary key,
  data jsonb not null,
  model text,
  ms integer,
  created_at bigint not null
);

create table if not exists brain_daily_digest (
  day text primary key,
  data jsonb not null,
  markdown text not null,
  updated_at bigint not null
);

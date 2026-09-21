-- Per-turn traces and Rosie 👍/👎. Cleanup jobs must not delete these rows.
create table if not exists turn_traces (
  turn_id text primary key,
  user_msg_id text,
  turn_seq bigint,
  created_at timestamptz not null default now(),
  retrieve jsonb,
  reflector jsonb,
  live jsonb,
  reply jsonb,
  commit_sha text,
  truncated boolean not null default false
);

create index if not exists turn_traces_created_idx on turn_traces (created_at desc);
create index if not exists turn_traces_seq_idx on turn_traces (turn_seq desc);
create index if not exists turn_traces_user_msg_idx on turn_traces (user_msg_id);

create table if not exists turn_feedback (
  id text primary key,
  turn_id text,
  message_id text not null,
  rating text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists turn_feedback_created_idx on turn_feedback (created_at desc);
create index if not exists turn_feedback_turn_idx on turn_feedback (turn_id);

alter table qingran_reply_flags
  add column if not exists rating text not null default 'down';
alter table qingran_reply_flags
  add column if not exists turn_id text;

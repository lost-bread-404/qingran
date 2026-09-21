alter table qingran_hearing_clips
  add column if not exists predicted_tags jsonb,
  add column if not exists gold_tags jsonb,
  add column if not exists tags_touched text[],
  add column if not exists commit_sha text,
  add column if not exists prompt_hash text,
  add column if not exists context_before jsonb,
  add column if not exists reply_message_id text;

alter table qingran_hearing_turns
  add column if not exists commit_sha text,
  add column if not exists prompt_hash text,
  add column if not exists context_before jsonb,
  add column if not exists reply_message_id text;

create table if not exists qingran_reply_flags (
  id text primary key,
  message_id text not null,
  reply_to_message_id text,
  note text,
  created_at timestamptz not null default now(),
  commit_sha text,
  prompt_hash text
);

create index if not exists qingran_reply_flags_created_idx
  on qingran_reply_flags (created_at desc);

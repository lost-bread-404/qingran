create table if not exists qr_prompts (
  key text primary key,
  body text not null,
  updated_at bigint not null
);

create table if not exists qr_prompt_versions (
  hash text primary key,
  key text not null,
  body text not null,
  first_seen bigint not null,
  last_seen bigint not null
);

create index if not exists qr_prompt_versions_key_idx on qr_prompt_versions (key);

alter table brain_log
  add column if not exists prompt_key text;
alter table brain_log
  add column if not exists prompt_hash text;

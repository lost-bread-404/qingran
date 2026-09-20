alter table qingran_hearing_clips
  add column if not exists prosody jsonb,
  add column if not exists stt_corrected_text text;

alter table qingran_hearing_turns
  add column if not exists stt_raw_text text,
  add column if not exists stt_corrected_text text,
  add column if not exists stt_corrections jsonb;

create table if not exists qingran_hearing_confusions (
  id text primary key,
  wrong text not null,
  correct text not null,
  count integer not null default 0,
  examples jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wrong, correct)
);

create index if not exists qingran_hearing_confusions_count_idx
  on qingran_hearing_confusions (count desc);

create table if not exists qingran_personal_lexicon (
  id text primary key,
  kind text not null,
  term text not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (kind, term)
);

create index if not exists qingran_personal_lexicon_kind_count_idx
  on qingran_personal_lexicon (kind, count desc);

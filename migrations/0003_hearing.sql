create table if not exists qingran_hearing_turns (
  id text primary key,
  created_at timestamptz not null default now(),
  provider text,
  model text,
  speech_start bigint,
  endpoint_fired bigint,
  upload_start bigint,
  stt_done bigint,
  grok_done bigint,
  tts_first_audio bigint,
  latency_ms integer,
  tokens_in integer,
  tokens_out integer,
  cost_usd double precision,
  refusal boolean not null default false,
  fallback boolean not null default false,
  fallback_reason text,
  cold_start_ms integer
);

create index if not exists qingran_hearing_turns_created_idx
  on qingran_hearing_turns (created_at desc);

create table if not exists qingran_hearing_clips (
  id text primary key,
  created_at timestamptz not null default now(),
  duration_ms integer,
  sample_rate integer not null default 16000,
  source text not null default 'real',
  category text,
  split text,
  blob_pathname text,
  audio_wav text,
  xai_text text,
  hearing_text text,
  hearing_json jsonb,
  live_text text,
  gold_text text,
  gold_cues jsonb,
  noise_only boolean,
  skip boolean not null default false,
  relabel_gold_text text,
  relabel_gold_cues jsonb,
  relabel_noise_only boolean
);

create index if not exists qingran_hearing_clips_created_idx
  on qingran_hearing_clips (created_at desc);

create index if not exists qingran_hearing_clips_category_idx
  on qingran_hearing_clips (category);

create index if not exists qingran_hearing_clips_split_idx
  on qingran_hearing_clips (split);

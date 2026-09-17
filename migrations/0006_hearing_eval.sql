alter table qingran_hearing_turns
  add column if not exists disagreement boolean not null default false;

alter table qingran_hearing_clips
  add column if not exists blob_error text,
  add column if not exists storage_backend text,
  add column if not exists gold_source text,
  add column if not exists stt_text text,
  add column if not exists gold_tier integer,
  add column if not exists utterance_emotion text,
  add column if not exists mode text,
  add column if not exists audio_route text,
  add column if not exists turn_id text,
  add column if not exists disagreement boolean not null default false;

create index if not exists qingran_hearing_clips_gold_source_idx
  on qingran_hearing_clips (gold_source);

create index if not exists qingran_hearing_clips_turn_id_idx
  on qingran_hearing_clips (turn_id);

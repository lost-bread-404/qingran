alter table qingran_hearing_clips
  add column if not exists voiced_ms integer,
  add column if not exists voice_num integer,
  add column if not exists voice_den integer,
  add column if not exists voice_noise boolean;

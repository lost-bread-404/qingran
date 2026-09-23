alter table qingran_hearing_clips
  add column if not exists voiced_ratio double precision,
  add column if not exists f0_min_hz integer,
  add column if not exists f0_max_hz integer;

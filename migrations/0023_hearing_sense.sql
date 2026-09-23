alter table qingran_hearing_clips
  add column if not exists tone_rise double precision,
  add column if not exists tone_glide double precision,
  add column if not exists tone_fade double precision,
  add column if not exists tone_peak double precision,
  add column if not exists tone_mark text,
  add column if not exists sense_line text;

alter table qingran_hearing_clips
  add column if not exists hear_to_trigger_ms integer,
  add column if not exists preroll_peak_rms double precision;

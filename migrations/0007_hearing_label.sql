alter table qingran_hearing_clips
  add column if not exists final_text text,
  add column if not exists peak_rms double precision,
  add column if not exists vad_floor double precision;

alter table qingran_hearing_turns
  add column if not exists live_text_source text,
  add column if not exists hallucination_suspect boolean not null default false,
  add column if not exists save_error text;

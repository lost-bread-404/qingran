alter table qingran_hearing_clips
  add column if not exists literal_mismatch boolean not null default false,
  add column if not exists tone_note text;

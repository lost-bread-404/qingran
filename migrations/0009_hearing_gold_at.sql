alter table qingran_hearing_clips
  add column if not exists gold_at timestamptz;

update qingran_hearing_clips
  set gold_at = created_at
  where gold_source is not null and gold_at is null;

create index if not exists qingran_hearing_clips_gold_at_idx
  on qingran_hearing_clips (gold_at desc)
  where gold_source is not null;

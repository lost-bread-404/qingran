-- Screen-clear cutoff; forgotten messages are skipped by archive/diary, not deleted.
alter table qingran_profile
  add column if not exists room_cleared_at bigint;

alter table qingran_messages
  add column if not exists forgotten_at bigint;

create index if not exists qingran_messages_forgotten_idx
  on qingran_messages (forgotten_at)
  where forgotten_at is not null;

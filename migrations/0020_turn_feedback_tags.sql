alter table turn_feedback
  add column if not exists tags text[] not null default '{}';

alter table qingran_reply_flags
  add column if not exists tags text[] not null default '{}';

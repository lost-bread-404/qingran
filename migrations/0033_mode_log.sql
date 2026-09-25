-- 戏 / 现实 for her next message, decided by reflect at the end of each turn.
create table if not exists qr_mode_log (
  id bigserial primary key,
  at bigint not null,
  mode text not null,
  until_at bigint,
  why text not null default '',
  source text not null default 'reflect'
);
create index if not exists qr_mode_log_at_idx on qr_mode_log (at desc, id desc);

-- 清然's running notes about Rosie's day, one plain sentence each, stamped at her message.
create table if not exists qr_day_notes (
  id bigserial primary key,
  at bigint not null,
  text text not null
);
create index if not exists qr_day_notes_at_idx on qr_day_notes (at desc, id desc);

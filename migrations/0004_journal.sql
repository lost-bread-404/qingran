-- 记忆系统工作底稿：聊天、L1/L2/L3、画像、未闭合草稿、A/B/C 过程。只追加，不覆盖。

create table if not exists qingran_journal (
  id text primary key,
  kind text not null,
  at bigint not null,
  clock text not null default '',
  body jsonb not null default '{}'::jsonb
);

create index if not exists qingran_journal_kind_at_idx
  on qingran_journal (kind, at);

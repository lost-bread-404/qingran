create table if not exists qr_inner (
  id int primary key default 1,
  feel text not null default '',
  want text not null default '',
  choice text not null default '',
  now_text text not null default '',
  longing text not null default '',
  plans jsonb not null default '[]'::jsonb,
  turn_seq bigint not null default 0,
  updated_at bigint not null default 0,
  longing_updated_at bigint not null default 0
);
insert into qr_inner (id) values (1) on conflict do nothing;

create table if not exists qr_inner_log (
  id bigserial primary key,
  turn_seq bigint not null,
  created_at bigint not null,
  data jsonb not null,
  model text,
  ms int
);

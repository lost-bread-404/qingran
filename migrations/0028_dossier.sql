create table if not exists qr_dossier (
  id int primary key default 1,
  body text not null default '',
  cursor_at bigint not null default 0,
  turns_since_edit int not null default 0,
  updated_at bigint not null default 0,
  version int not null default 0,
  -- Not in the sketch: hot path stays on the old longterm text until Rosie enables a draft.
  active boolean not null default false
);
insert into qr_dossier (id) values (1) on conflict do nothing;

create table if not exists qr_dossier_versions (
  id bigserial primary key,
  version int not null,
  body text not null,
  author text not null,
  ops jsonb,
  created_at bigint not null
);

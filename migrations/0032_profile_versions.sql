alter table qingran_profile
  add column if not exists field_revs jsonb not null default '{}'::jsonb;

create table if not exists qr_profile_versions (
  id bigserial primary key,
  field text not null,
  value text not null,
  source text not null default '',
  at bigint not null
);

create index if not exists qr_profile_versions_field_at_idx
  on qr_profile_versions (field, at desc, id desc);

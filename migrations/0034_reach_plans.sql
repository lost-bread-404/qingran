-- Several pending plans to reach out to Rosie at once (check on her rest, say a few words when he misses her, ...).
create table if not exists qr_reach_plans (
  id bigserial primary key,
  at bigint not null,
  intent text not null default '',
  set_by text not null default '',
  set_at bigint not null default 0,
  done_at bigint
);
create index if not exists qr_reach_plans_pending_idx on qr_reach_plans (at) where done_at is null;

-- Carry over the single pending plan from qr_reach.
insert into qr_reach_plans (at, intent, set_by, set_at)
select next_at, intent, set_by, set_at from qr_reach
where id = 1 and next_at is not null
  and not exists (select 1 from qr_reach_plans);

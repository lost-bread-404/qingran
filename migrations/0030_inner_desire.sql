alter table qr_inner add column if not exists desire text not null default '';
alter table qr_inner add column if not exists read_her text not null default '';

update qr_inner
set desire = want
where desire = '' and want <> '';

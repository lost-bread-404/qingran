alter table qr_portrait add column if not exists kind text not null default 'trait';
alter table qr_portrait add column if not exists support_count integer not null default 1;
alter table qr_portrait add column if not exists last_supported_at bigint;

update qr_portrait set last_supported_at = updated_at where last_supported_at is null;
update qr_portrait set kind = 'trait' where kind is null or kind = '';
update qr_portrait set status = 'stale' where status = 'dormant';

alter table qr_portrait alter column last_supported_at set default 0;
alter table qr_portrait alter column last_supported_at set not null;

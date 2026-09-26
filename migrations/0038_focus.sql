-- The one thing he means to do right now. The reply sees only this and his heart, never the plan list.
alter table qr_inner add column if not exists focus text not null default '';

-- 2026-09-27: the reply works on the first due item of his plan list, so there is no separate focus (requirements 变更记录).
-- now_text now holds his last thought, for the record only.
alter table qr_inner drop column if exists focus;

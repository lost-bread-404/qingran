-- 2026-10-03: a reply in a phone call round is written by the newest attempt only. While she goes on, the phone asks
-- again for the same reply; an older attempt that finishes later must not overwrite the one she heard.
alter table qingran_messages add column if not exists attempt_at bigint;

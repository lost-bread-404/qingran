-- 2026-10-03: who knows a memory. Empty: 清然 knows it (he was there, or was told). Otherwise the names of the
-- others who were there (「林泽」): it comes back only while one of them is in the scene, never to 清然 alone.
alter table qr_memories add column if not exists knows text not null default '';

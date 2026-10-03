-- 2026-10-03: the proactive-message switch keeps only on/off and its one retry. next_at / intent / set_by / set_at
-- were the v5 planned message (打算单), which nothing reads any more.
alter table qr_reach
  drop column if exists next_at,
  drop column if exists intent,
  drop column if exists set_by,
  drop column if exists set_at;

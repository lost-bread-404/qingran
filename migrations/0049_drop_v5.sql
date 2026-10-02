-- 2026-10-02: what was left of v5 (the 心思 / reflect step, modes, 打算单). What it taught is in docs/history.md.
drop table if exists qr_mode_log;
drop table if exists qr_reach_plans;
-- qr_inner keeps only what proactive messages use (which silence he last thought about, how far into it).
alter table qr_inner
  drop column if exists feel,
  drop column if exists want,
  drop column if exists choice,
  drop column if exists now_text,
  drop column if exists longing,
  drop column if exists plans,
  drop column if exists turn_seq,
  drop column if exists updated_at,
  drop column if exists longing_updated_at,
  drop column if exists intimate,
  drop column if exists intimate_at,
  drop column if exists glow,
  drop column if exists glow_at,
  drop column if exists longings,
  drop column if exists desire,
  drop column if exists read_her,
  drop column if exists scene,
  drop column if exists focus;
-- The inner log keeps the night pass and clears; the 心思 outputs go.
delete from qr_inner_log where coalesce(data->>'kind', '') not in ('night', 'cleared_by_rosie');

-- 2026-09-26: leftovers of retired parts (requirements 变更记录). Messages, memory, hearing clips, logs and spend records stay.
-- The old inner state (v4): only now_text, focus, turn_seq, updated_at and silence_seen are read since v5.
alter table qr_inner
  drop column if exists feel,
  drop column if exists desire,
  drop column if exists read_her,
  drop column if exists want,
  drop column if exists choice,
  drop column if exists scene,
  drop column if exists longing,
  drop column if exists longings,
  drop column if exists longing_updated_at,
  drop column if exists plans,
  drop column if exists glow,
  drop column if exists glow_at;

-- Engine comparison runs (Qwen / Gemini / self-hosted hearing were dropped) and the retired spend-limit overrides. Both empty.
drop table if exists qingran_eval_runs;
drop table if exists spend_overrides;


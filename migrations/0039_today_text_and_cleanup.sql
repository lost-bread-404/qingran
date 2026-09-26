-- 2026-09-26 cleanup (docs/requirements.md 变更记录).
-- Messages, her settings, the memory and its versions, hearing clips, logs and spend records all stay.
-- What goes: tables that only held derived or duplicate information from retired parts of the brain.

-- 1. 「今天」 is now one text per day in qr_days. Fold the old per-line notes into the day they belong to
--    (days run 04:00–04:00 in her zone), only where that day has no text yet.
insert into qr_days (day, timeline, updated_at)
select d.day, string_agg(d.line, E'\n' order by d.at), max(d.at)
from (
  select
    n.at,
    to_char((to_timestamp(n.at / 1000.0) at time zone 'America/New_York') - interval '4 hours', 'YYYY-MM-DD') as day,
    to_char(to_timestamp(n.at / 1000.0) at time zone 'America/New_York', 'HH24:MI') || ' ' || n.text as line
  from qr_day_notes n
) d
group by d.day
on conflict (day) do update
  set timeline = excluded.timeline, updated_at = excluded.updated_at
  where qr_days.timeline = '';

-- 2. Retired: observation notes, portrait, old mind, closeness number, busy table, diary analysis, daily digest,
--    the v1 memories list, and the per-line day notes folded in above.
drop table if exists
  qr_day_notes,
  qr_glow_events,
  qr_busy_periods,
  qr_portrait,
  qr_mind,
  qr_mind_history,
  mem_notes,
  mem_history,
  qingran_memories,
  diary_day_factors,
  diary_episodes,
  diary_experiments,
  diary_factors,
  diary_findings,
  diary_intention_ops,
  diary_intentions,
  diary_theme_members,
  diary_theme_weeks,
  diary_themes,
  diary_days,
  brain_daily_digest
  cascade;

-- 3. Settings no longer read by the app.
update qingran_profile
set data = coalesce(data, '{}'::jsonb)
  - 'realModel' - 'realEffort' - 'realPrompt'
  - 'autoRemember' - 'injectMemories'
  - 'portraitActiveMax' - 'portraitStaleDays' - 'retrieveMinTerms'
  - 'glowHalfLifeDays' - 'routine'
where id = 1;

-- Brain v5: heart (qr_inner.now_text) + plans (qr_reach_plans, time optional) + today + memory + modes.
-- Plans without a time are things he means to do next; only timed ones wake him.
alter table qr_reach_plans alter column at drop not null;

-- One short timeline per day (04:00–04:00 local), written by the night pass.
create table if not exists qr_days (
  day text primary key,
  timeline text not null default '',
  updated_at bigint not null default 0
);

-- The silence this heart already thought about (her last message time), so one silence gets one thought.
alter table qr_inner add column if not exists silence_seen bigint not null default 0;

-- The brain switch alone decides what the reply sees; the two older per-block switches go back on.
update qingran_profile
set data = coalesce(data, '{}'::jsonb) || '{"injectMind": true, "injectLongterm": true}'::jsonb
where id = 1;

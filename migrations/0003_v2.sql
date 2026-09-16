-- 清然 v2：共享记忆库 + 清然内心 + 日记
-- Compatible with Postgres and PGLite. No vector extension.

-- ========== L0 ==========
alter table qingran_messages
  add column if not exists kind text not null default 'say';
alter table qingran_messages
  add column if not exists archived_at bigint;
alter table qingran_messages
  add column if not exists session_id text;
alter table qingran_messages
  add column if not exists local_day text;

-- Prefix migration (idempotent): scanned / steer / setting markers become columns.
update qingran_messages
set archived_at = coalesce(archived_at, created_at)
where archived_at is null
  and (body like '⟦已扫⟧%' or body like E'\\u27e6已扫\\u27e7%');

update qingran_messages
set kind = 'steer'
where kind = 'say'
  and (body like '%⟦走向⟧%' or body like '⟦走向⟧%' or body like '⟦已扫⟧⟦走向⟧%');

update qingran_messages
set kind = 'setting'
where kind = 'say'
  and (body like '%⟦设定⟧%' or body like '⟦设定⟧%' or body like '⟦已扫⟧⟦设定⟧%');

update qingran_messages
set body = regexp_replace(body, '^⟦已扫⟧', '')
where body like '⟦已扫⟧%';

update qingran_messages
set body = regexp_replace(body, '^⟦走向⟧', '')
where body like '⟦走向⟧%';

update qingran_messages
set body = regexp_replace(body, '^⟦设定⟧', '')
where body like '⟦设定⟧%';

update qingran_messages
set local_day = to_char(to_timestamp(created_at / 1000.0) - interval '4 hours', 'YYYY-MM-DD')
where local_day is null;

update qingran_messages
set session_id = 'd:' || local_day
where session_id is null and local_day is not null;

-- ========== L1 Notes ==========
create table if not exists mem_notes (
  id text primary key,
  text text not null,
  tags text[] not null default '{}',
  subject text not null,
  lens text[] not null,
  from_rosie boolean not null,
  weight smallint not null default 3,
  status text not null default 'active',
  superseded_by text,
  links text[] not null default '{}',
  happened_at bigint not null,
  local_day text not null,
  source_ids text[] not null default '{}',
  recall_count integer not null default 0,
  last_recalled_at bigint,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists mem_notes_day_idx on mem_notes (local_day);
create index if not exists mem_notes_status_idx on mem_notes (status, subject);

create table if not exists mem_history (
  id bigserial primary key,
  table_name text not null,
  row_id text not null,
  op text not null,
  before jsonb,
  after jsonb,
  job_id text,
  at bigint not null
);

-- Import old qingran_memories as notes (old table kept).
insert into mem_notes (
  id, text, tags, subject, lens, from_rosie, weight, status, links,
  happened_at, local_day, source_ids, created_at, updated_at
)
select
  'legacy:' || id,
  body,
  '{}'::text[],
  'us',
  array['bond','diary']::text[],
  true,
  4,
  'active',
  '{}'::text[],
  created_at,
  to_char(to_timestamp(created_at / 1000.0) - interval '4 hours', 'YYYY-MM-DD'),
  '{}'::text[],
  created_at,
  updated_at
from qingran_memories
on conflict (id) do nothing;

-- ========== 清然侧 ==========
create table if not exists qr_portrait (
  id text primary key,
  topic text not null unique,
  body text not null,
  status text not null default 'active',
  evidence_ids text[] not null default '{}',
  last_seen bigint not null,
  updated_at bigint not null
);

create table if not exists qr_mind (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  turn_seq bigint not null default 0,
  updated_at bigint not null default 0
);
insert into qr_mind (id) values (1) on conflict (id) do nothing;

-- ========== 日记侧 ==========
create table if not exists diary_days (
  day text primary key,
  summary text not null default '',
  energy smallint,
  mood smallint,
  body text,
  did jsonb not null default '[]',
  avoided jsonb not null default '[]',
  events jsonb not null default '[]',
  wins jsonb not null default '[]',
  first_active bigint,
  last_active bigint,
  msg_count integer not null default 0,
  coverage text not null default 'none',
  note_ids text[] not null default '{}',
  version integer not null default 1,
  updated_at bigint not null
);

create table if not exists diary_intentions (
  id text primary key,
  text text not null,
  tag text,
  stated_at bigint not null,
  target_day text,
  status text not null default 'open',
  started_at bigint,
  done_at bigint,
  last_evidence_at bigint not null,
  evidence_ids text[] not null default '{}',
  updated_at bigint not null
);

create table if not exists diary_factors (
  id text primary key,
  name text not null unique,
  definition text not null,
  version integer not null default 1,
  is_outcome boolean not null default false,
  status text not null default 'active',
  origin text not null,
  user_feedback text,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists diary_day_factors (
  day text not null,
  factor_id text not null,
  version integer not null,
  value smallint,
  evidence_ids text[] not null default '{}',
  primary key (day, factor_id)
);

create table if not exists diary_themes (
  id text primary key,
  name text not null,
  definition text not null,
  version integer not null default 1,
  status text not null default 'active',
  merged_into text,
  parent_id text,
  user_feedback text,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists diary_theme_members (
  theme_id text not null,
  note_id text not null,
  version integer not null,
  primary key (theme_id, note_id)
);

create table if not exists diary_theme_weeks (
  theme_id text not null,
  week text not null,
  mentions integer not null,
  action_taken smallint,
  mood_avg real,
  primary key (theme_id, week)
);

create table if not exists diary_episodes (
  id text primary key,
  factor_id text not null,
  start_day text not null,
  end_day text,
  end_known boolean not null default false,
  days integer not null,
  evidence_ids text[] not null default '{}',
  computed_at bigint not null
);

create table if not exists diary_findings (
  id text primary key,
  kind text not null,
  outcome_id text not null,
  antecedent_id text not null,
  lag integer not null,
  n11 integer not null,
  n10 integer not null,
  n01 integer not null,
  n00 integer not null,
  lift real not null,
  score real not null,
  example_days text[] not null default '{}',
  counter_days text[] not null default '{}',
  user_feedback text,
  computed_at bigint not null
);

create table if not exists diary_experiments (
  id text primary key,
  hypothesis text not null,
  action text not null,
  outcome_id text not null,
  compliance_factor_id text,
  start_day text not null,
  end_day text not null,
  status text not null default 'proposed',
  result jsonb,
  created_at bigint not null
);

create table if not exists diary_reports (
  id text primary key,
  period_start text not null,
  period_end text not null,
  data jsonb not null,
  narrative text not null,
  created_at bigint not null
);

-- ========== 基础设施 ==========
create table if not exists brain_meta (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb
);
insert into brain_meta (id) values (1) on conflict (id) do nothing;

create table if not exists brain_jobs (
  id text primary key,
  type text not null,
  dedupe_key text unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempts integer not null default 0,
  run_after bigint not null,
  locked_until bigint,
  last_error text,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists brain_jobs_pending_idx on brain_jobs (status, run_after);

create table if not exists brain_log (
  id bigserial primary key,
  job_id text,
  step text not null,
  ok boolean not null,
  ms integer,
  input_chars integer,
  raw text,
  note text,
  at bigint not null
);

-- Seed factors (origin=seed). Upsert by name so re-running is safe.
insert into diary_factors (id, name, definition, version, is_outcome, status, origin, created_at, updated_at)
values
  ('seed-启动困难', '启动困难', '她表达想做某事却迟迟开始不了、拖延、打开就想躺', 1, true, 'active', 'seed', 0, 0),
  ('seed-情绪低落', '情绪低落', '明显的低落、沮丧、无力、想哭、自我否定', 1, true, 'active', 'seed', 0, 0),
  ('seed-身体不适', '身体不适', '提到任何身体不舒服（疼痛、溃疡、生病、失眠等）', 1, true, 'active', 'seed', 0, 0),
  ('seed-高效推进', '高效推进', '明确完成或推进了学习/工作任务', 1, true, 'active', 'seed', 0, 0),
  ('seed-熬夜', '熬夜', '最晚活跃时间晚于 02:00，或她说很晚才睡（代码判定为主）', 1, false, 'active', 'seed', 0, 0),
  ('seed-社交消耗', '社交消耗', '与他人的互动让她疲惫、紧张或不愉快', 1, false, 'active', 'seed', 0, 0),
  ('seed-被评价被拒', '被评价/被拒', '面试、考试、申请结果、被批评、被拒绝', 1, false, 'active', 'seed', 0, 0),
  ('seed-运动', '运动', '提到去健身或运动', 1, false, 'active', 'seed', 0, 0)
on conflict (id) do nothing;

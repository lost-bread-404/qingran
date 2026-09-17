create table if not exists spend_events (
  id bigserial primary key,
  at bigint not null,
  day text not null,
  month text not null,
  kind text not null,
  route text not null,
  model text,
  tokens_in integer,
  tokens_cached integer,
  tokens_out integer,
  tokens_reasoning integer,
  chars integer,
  seconds real,
  usd real not null,
  estimated boolean not null default false,
  turn_seq bigint,
  job_id text,
  log_id bigint
);
create index if not exists spend_events_day_idx on spend_events (day);
create index if not exists spend_events_month_idx on spend_events (month);
create index if not exists spend_events_route_idx on spend_events (route, day);

create table if not exists spend_daily (
  day text not null,
  route text not null,
  usd real not null default 0,
  calls integer not null default 0,
  primary key (day, route)
);

create table if not exists spend_alerts (
  id bigserial primary key,
  at bigint not null,
  day text not null,
  month text not null,
  scope text not null,
  level text not null,
  total_usd real,
  detail text
);

create table if not exists spend_overrides (
  id bigserial primary key,
  scope text not null,
  period text not null,
  created_at bigint not null,
  note text
);

create table if not exists spend_reconcile (
  month text primary key,
  actual_usd real not null,
  estimated_usd real not null,
  entered_at bigint not null
);

create table if not exists spend_rate (
  bucket text primary key,
  n integer not null default 0
);

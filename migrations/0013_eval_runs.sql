create table if not exists qingran_eval_runs (
  id text primary key,
  clip_id text not null,
  engine text not null,
  text text,
  tags jsonb,
  latency_ms integer,
  status text not null,
  error text,
  created_at timestamptz not null default now(),
  unique (clip_id, engine)
);

create index if not exists qingran_eval_runs_engine_idx
  on qingran_eval_runs (engine);

create index if not exists qingran_eval_runs_clip_idx
  on qingran_eval_runs (clip_id);

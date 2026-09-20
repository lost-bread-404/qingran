-- Jump detection + query-path telemetry for the voice hot path.
-- Idempotent: Postgres and PGLite.

alter table brain_turns
  add column if not exists jump boolean not null default false,
  add column if not exists jump_score real,
  add column if not exists query_ids text[] not null default '{}',
  add column if not exists query_scores real[] not null default '{}';

-- TODO: embeddings / vector column. Do not create extension vector in this
-- migration. Related MiniSearch (tags + aliases) lands in a later commit;
-- dense retrieval is out of scope.

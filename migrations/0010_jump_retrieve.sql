-- Jump detection + query-path telemetry for the voice hot path.
-- Aliases on notes (search-only; never shown to 清然).
-- Idempotent: Postgres and PGLite.

alter table brain_turns
  add column if not exists jump boolean not null default false,
  add column if not exists jump_score real,
  add column if not exists query_ids text[] not null default '{}',
  add column if not exists query_scores real[] not null default '{}';

alter table mem_notes
  add column if not exists aliases text[] not null default '{}';

-- TODO: embeddings / vector column. Do not create extension vector in this
-- migration. Dense retrieval is out of scope; MiniSearch covers tags+aliases.

-- 2026-10-02: Rosie's complaints about how 清然 behaved, found by the night pass (or sorted out by hand).
-- Kept for tuning the app; never shown to 清然 and never recalled (most came from prompts since fixed).
create table if not exists qr_feedback (
  id bigserial primary key,
  day text not null default '',
  at bigint,
  body text not null,
  source text not null default 'night',  -- night | claude
  created_at bigint not null
);

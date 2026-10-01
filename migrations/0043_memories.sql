-- 2026-10-01: memory as recollections (docs/brain.md v6).
-- Each row is one moment of the two of them (or something 清然 came to understand about Rosie), kept for good:
-- nothing is rewritten or deleted by the night pass; a moment that stopped being true gets a 「后来」 note.
-- The reply recalls the few that fit what Rosie is saying now. qr_dossier becomes 「清然和 Rosie 现在」.
create table if not exists qr_memories (
  id bigserial primary key,
  kind text not null default 'moment',      -- moment | insight
  source text not null default 'night',     -- story (cut from her storyline) | night | rosie
  day text not null default '',             -- local day it happened ('' for the story)
  at bigint,                                -- when it happened (null for the story)
  seq int not null default 0,               -- order inside the story
  body text not null,
  keys text not null default '',            -- people, places, things, feelings, other words for it
  thread text not null default '',          -- the ongoing line it belongs to (林泽, 找实习…)
  importance int not null default 5,        -- 1–10
  changed text not null default '',         -- what became of it later
  recalled int not null default 0,
  recalled_at bigint,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists qr_memories_thread on qr_memories (thread);

-- day:YYYY-MM-DD → the night pass folded that day in; story → hash of the storyline last cut into moments.
create table if not exists qr_memory_marks (
  key text primary key,
  value text not null default '',
  at bigint not null
);

-- Proactive messages: which step of the current silence he has already thought about.
alter table qr_inner add column if not exists reach_stage int not null default 0;

-- Whether the two of them are in an intimate scene right now: judged after each reply, read by the next one
-- (the intimate notes come in only then).
alter table qr_inner add column if not exists intimate boolean not null default false;
alter table qr_inner add column if not exists intimate_at bigint not null default 0;

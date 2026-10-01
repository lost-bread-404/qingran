-- 2026-10-01: each memory also keeps a vector of its meaning (docs/brain.md「怎么想起来」), so a moment is found by
-- what it means, not only by its words. Stored as a plain array and compared in code: the memory is small.
alter table qr_memories add column if not exists vec real[];
alter table qr_memories add column if not exists vec_model text not null default '';

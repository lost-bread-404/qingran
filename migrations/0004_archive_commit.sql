-- Archivist 原子提交：notes 先以 pending 写入，再用单条语句同时
-- 标记消息已归档、执行 supersede、把 pending 转为 active。
alter table mem_notes
  add column if not exists batch_key text;
alter table mem_notes
  add column if not exists supersedes text;
create index if not exists mem_notes_batch_idx on mem_notes (batch_key, status);

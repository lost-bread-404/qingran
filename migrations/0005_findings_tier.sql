-- Findings 两档：finding（p≤0.01）与 clue（p≤0.05，含全部恢复路径）
alter table diary_findings
  add column if not exists tier text not null default 'finding';

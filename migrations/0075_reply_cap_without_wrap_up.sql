-- 2026-10-10: every reply of his ended in a summing-up line (「那就继续躺着，姐姐陪你」「小猫，姐姐爱你」), telling
-- what the action already showed. The per-turn block, right before her line, still said 「想好了再说，把最要紧的
-- 说完」, written on 10/4 when a too-long reply was cut mid-sentence; nothing cuts it now, so all it did was ask
-- each reply to land a point. Taken out of a saved 每轮回复 (the default changed in templates.ts); the version
-- before is kept in the history first.
insert into qr_prompt_versions (hash, key, body, first_seen, last_seen)
select md5(p.body), p.key, p.body, p.updated_at, (extract(epoch from now()) * 1000)::bigint
from qr_prompts p
where p.key = 'voice' and not exists (select 1 from qr_prompt_versions v where v.key = p.key and v.body = p.body);

update qr_prompts
set body = replace(body, '（旁白和说的话一起算），想好了再说，把最要紧的说完。', '（旁白和说的话一起算）。'),
  updated_at = (extract(epoch from now()) * 1000)::bigint
where key = 'voice' and position('，想好了再说，把最要紧的说完。' in body) > 0;

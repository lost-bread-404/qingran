-- 2026-10-10: what 清然 remembers is in his own voice (「我」是清然, Rosie by name): her saved 每轮回复 gets the new
-- heading over the dossier, the same as the default in templates.ts. The version before is kept in the history first.
insert into qr_prompt_versions (hash, key, body, first_seen, last_seen)
select md5(p.body), p.key, p.body, p.updated_at, (extract(epoch from now()) * 1000)::bigint
from qr_prompts p
where p.key = 'voice' and not exists (select 1 from qr_prompt_versions v where v.key = p.key and v.body = p.body);

update qr_prompts
set body = replace(body, '你记着的（{us_when}整理的）：', '你自己记着的（{us_when}整理的，「我」是你）：'),
  updated_at = (extract(epoch from now()) * 1000)::bigint
where key = 'voice' and position('你记着的（{us_when}整理的）：' in body) > 0;

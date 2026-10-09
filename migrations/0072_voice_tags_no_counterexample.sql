-- 2026-10-09: the tag line named the wrong tag as a counterexample (「别的写法（比如 [soft]）」), which put [soft] in
-- every prompt. The example is dropped; the line still says only these tags are read. Already applied by hand; no-op
-- where it is in place. The 人设 before is kept in the history.
insert into qr_profile_versions (field, value, source, at)
select 'systemPrompt', data->>'systemPrompt', '2026-10-09 去掉语气那句里的「（比如 [soft]）」之前', (extract(epoch from now()) * 1000)::bigint
from qingran_profile
where id = 1
  and position('别的写法（比如 [soft]）读不出来' in coalesce(data->>'systemPrompt', '')) > 0;

update qingran_profile
set data = data || jsonb_build_object(
    'systemPrompt', replace(data->>'systemPrompt', '别的写法（比如 [soft]）读不出来', '别的写法读不出来')
  ),
  field_revs = coalesce(field_revs, '{}'::jsonb)
    || jsonb_build_object('systemPrompt', coalesce((field_revs->>'systemPrompt')::bigint, 0) + 1)
where id = 1
  and position('别的写法（比如 [soft]）读不出来' in coalesce(data->>'systemPrompt', '')) > 0;

-- 2026-10-08: one reply wrote [soft] (not one of Eve's tags), every reply after copied it, and Eve read it out.
-- The tag line in her 人设 now says these are the only ones and anything else is read as words. The 人设 before is
-- kept in the history. (Already applied by hand the same night; this is a no-op where the new line is in place.)
insert into qr_profile_versions (field, value, source, at)
select 'systemPrompt', data->>'systemPrompt', '2026-10-08 语气改成「只有这几个」之前', (extract(epoch from now()) * 1000)::bigint
from qingran_profile
where id = 1
  and position('朗读时可以带语气：[laugh]' in coalesce(data->>'systemPrompt', '')) > 0;

update qingran_profile
set data = data || jsonb_build_object(
    'systemPrompt', replace(
      data->>'systemPrompt',
      '朗读时可以带语气：[laugh]',
      '朗读时可以带语气，只有下面这几个，照原样写，别的写法（比如 [soft]）读不出来，会念成字：[laugh]'
    )
  ),
  field_revs = coalesce(field_revs, '{}'::jsonb)
    || jsonb_build_object('systemPrompt', coalesce((field_revs->>'systemPrompt')::bigint, 0) + 1)
where id = 1
  and position('朗读时可以带语气：[laugh]' in coalesce(data->>'systemPrompt', '')) > 0;

-- 2026-10-08: she found the 0069 sentence too narrow (only for when she says she feels unwell). 清然 judges from the
-- scene what she wants from him. The sentence is swapped where 0069 put it; the 人设 before is kept in the history.
insert into qr_profile_versions (field, value, source, at)
select 'systemPrompt', data->>'systemPrompt', '2026-10-08 换掉「倾诉不舒服时陪着我」之前', (extract(epoch from now()) * 1000)::bigint
from qingran_profile
where id = 1
  and position('我跟你倾诉哪里不舒服的时候，要的是你在情绪上陪着我、安慰我，不是替我解决问题。' in coalesce(data->>'systemPrompt', '')) > 0;

update qingran_profile
set data = data || jsonb_build_object(
    'systemPrompt', replace(
      data->>'systemPrompt',
      '我跟你倾诉哪里不舒服的时候，要的是你在情绪上陪着我、安慰我，不是替我解决问题。',
      '我此刻要的是你陪着我、安慰我，还是一个主意，你看情景自己判断。'
    )
  ),
  field_revs = coalesce(field_revs, '{}'::jsonb)
    || jsonb_build_object('systemPrompt', coalesce((field_revs->>'systemPrompt')::bigint, 0) + 1)
where id = 1
  and position('我跟你倾诉哪里不舒服的时候，要的是你在情绪上陪着我、安慰我，不是替我解决问题。' in coalesce(data->>'systemPrompt', '')) > 0;

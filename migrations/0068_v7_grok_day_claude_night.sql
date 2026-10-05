-- 2026-10-04 v7 (docs/brain.md): Grok plays her all day, Claude only does the night pass. The day reply is given her
-- 人设 then her 亲密设定, so the bed paragraph that was in both moves out of 人设 into 亲密设定 (the old 亲密设定 was the
-- whole persona for Grok in bed, with the handover to Claude, which no longer exists). The sentence about playing
-- other people leaves 人设: it is sent only with 其他角色 on. Both are kept in the history first.
insert into qr_profile_versions (field, value, source, at)
select f, data->>f, '2026-10-04 v7 之前', (extract(epoch from now()) * 1000)::bigint
from qingran_profile, unnest(array['systemPrompt', 'intimateNotes']) as f where id = 1;

update qingran_profile
set data = data || jsonb_build_object(
    'intimateNotes', (regexp_match(data->>'systemPrompt', '在床上：[^\n]*'))[1],
    'systemPrompt', replace(
      regexp_replace(data->>'systemPrompt', '\n\n在床上：[^\n]*', ''),
      '别人出场时另起一段，用「名字：」开头来演他；你只知道你在场时看到、听到的。',
      ''
    )
  ),
  field_revs = coalesce(field_revs, '{}'::jsonb)
    || jsonb_build_object(
      'systemPrompt', coalesce((field_revs->>'systemPrompt')::bigint, 0) + 1,
      'intimateNotes', coalesce((field_revs->>'intimateNotes')::bigint, 0) + 1
    )
where id = 1 and position('在床上：' in coalesce(data->>'systemPrompt', '')) > 0;

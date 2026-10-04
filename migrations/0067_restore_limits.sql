-- 2026-10-04: 0066 rewrote the three personas in positive terms only, and that changed what real limits meant (her
-- taboo, what 清然 does not say). She did not want it. Each persona goes back to what it was just before 0066 (kept in
-- the history), with only the ｛｝ sentence extended to the state of the scene. A persona she has edited since 0066 is
-- left as she wrote it.
update qingran_profile
set data = data || jsonb_build_object(
    'systemPrompt', case when position('每句都是此刻新的' in data->>'systemPrompt') > 0 and (select value from qr_profile_versions where field = 'systemPrompt' and source = '2026-10-04 改成只写正向设定之前' order by at desc, id desc limit 1) is not null
      then replace((select value from qr_profile_versions where field = 'systemPrompt' and source = '2026-10-04 改成只写正向设定之前' order by at desc, id desc limit 1), '之后要守住的客观的东西（游戏里选好的答案和底牌、比分、答应过的事、自己编出来的细节）写在｛｝里，Rosie看不到，之后每轮都会给你看；', '之后要守住的客观的东西写在｛｝里：此刻的状态（在哪、穿着什么、身上戴着什么），游戏里选好的答案和底牌、比分、答应过的事、自己编出来的细节；状态变了就写一条新的。Rosie看不到，之后每轮都会给你看；') else data->>'systemPrompt' end,
    'claudePrompt', case when position('每句都是此刻新的' in coalesce(data->>'claudePrompt', '')) > 0 and (select value from qr_profile_versions where field = 'claudePrompt' and source = '2026-10-04 改成只写正向设定之前' order by at desc, id desc limit 1) is not null
      then replace((select value from qr_profile_versions where field = 'claudePrompt' and source = '2026-10-04 改成只写正向设定之前' order by at desc, id desc limit 1), '之后要守住的客观的东西（游戏里选好的答案和底牌、比分、答应过的事、自己编出来的细节）写在｛｝里，Rosie看不到，之后每轮都会给你看；', '之后要守住的客观的东西写在｛｝里：此刻的状态（在哪、穿着什么、身上戴着什么），游戏里选好的答案和底牌、比分、答应过的事、自己编出来的细节；状态变了就写一条新的。Rosie看不到，之后每轮都会给你看；') else data->>'claudePrompt' end,
    'intimateNotes', case when position('每句都是此刻新的' in data->>'intimateNotes') > 0 and (select value from qr_profile_versions where field = 'intimateNotes' and source = '2026-10-04 改成只写正向设定之前' order by at desc, id desc limit 1) is not null
      then replace((select value from qr_profile_versions where field = 'intimateNotes' and source = '2026-10-04 改成只写正向设定之前' order by at desc, id desc limit 1), '之后要守住的客观的东西（答应过的事、定下的规矩）写在｛｝里，Rosie看不到，之后每轮都会给你看；', '之后要守住的客观的东西写在｛｝里：此刻的状态（什么姿势、身上穿着什么、戴着什么、绑着什么），答应过的事、定下的规矩；状态变了就写一条新的。Rosie看不到，之后每轮都会给你看；') else data->>'intimateNotes' end
  ),
  field_revs = coalesce(field_revs, '{}'::jsonb)
    || jsonb_build_object(
      'systemPrompt', coalesce((field_revs->>'systemPrompt')::bigint, 0) + 1,
      'intimateNotes', coalesce((field_revs->>'intimateNotes')::bigint, 0) + 1,
      'claudePrompt', coalesce((field_revs->>'claudePrompt')::bigint, 0) + 1
    )
where id = 1;

insert into qr_profile_versions (field, value, source, at)
select f, data->>f, '2026-10-04 恢复限制、｛｝加上此刻的状态', (extract(epoch from now()) * 1000)::bigint
from qingran_profile, unnest(array['systemPrompt', 'claudePrompt', 'intimateNotes']) as f where id = 1;

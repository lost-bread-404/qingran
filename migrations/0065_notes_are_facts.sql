-- 2026-10-04: ｛｝ is for what he has to keep to (a game's answer, his cards, a score, a promise, a detail he made up),
-- not for what he thinks of her: a judgement kept there held him in one state across turns. In all three personas.
update qingran_profile
set data = data
  || jsonb_build_object(
    'systemPrompt', replace(data->>'systemPrompt', '不说出口的想法写在｛｝里，Rosie看不到，你之后会记得。', '之后要守住的客观的东西（游戏里选好的答案和底牌、比分、答应过的事、自己编出来的细节）写在｛｝里，Rosie看不到，之后每轮都会给你看；你对Rosie的看法每次都按她刚说的重新来，不写进去。'),
    'claudePrompt', replace(coalesce(data->>'claudePrompt', ''), '不说出口的想法写在｛｝里，Rosie看不到，你之后会记得。', '之后要守住的客观的东西（游戏里选好的答案和底牌、比分、答应过的事、自己编出来的细节）写在｛｝里，Rosie看不到，之后每轮都会给你看；你对Rosie的看法每次都按她刚说的重新来，不写进去。'),
    'intimateNotes', replace(data->>'intimateNotes', '不说出口的想法写在｛｝里，Rosie看不到。', '之后要守住的客观的东西（答应过的事、定下的规矩）写在｛｝里，Rosie看不到，之后每轮都会给你看；你对Rosie的看法每次都按她刚说的重新来，不写进去。')
  ),
  field_revs = coalesce(field_revs, '{}'::jsonb)
    || jsonb_build_object(
      'systemPrompt', coalesce((field_revs->>'systemPrompt')::bigint, 0) + 1,
      'intimateNotes', coalesce((field_revs->>'intimateNotes')::bigint, 0) + 1,
      'claudePrompt', coalesce((field_revs->>'claudePrompt')::bigint, 0) + 1
    )
where id = 1;

-- The notes written so far are mostly judgements of her (「她现在最需要……」); they go, so none of them holds him.
delete from qr_memories where source = 'inner';

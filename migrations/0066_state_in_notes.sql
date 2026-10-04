-- 2026-10-04: ｛｝ also keeps the state of the scene (what is on, off, where), a new note when it changes: at 14:33 he
-- took the ring as still on although taking it off was in the talk he was given (eight turns back); following the state
-- through his long replies is where he slips. Only that sentence changes in each persona; the rest is hers as it is.
update qingran_profile
set data = data || jsonb_build_object(
    'systemPrompt', replace(data->>'systemPrompt',
      '之后要守住的客观的东西（游戏里选好的答案和底牌、比分、答应过的事、自己编出来的细节）写在｛｝里，Rosie看不到，之后每轮都会给你看；',
      '之后要守住的客观的东西写在｛｝里：此刻的状态（在哪、穿着什么、身上戴着什么），游戏里选好的答案和底牌、比分、答应过的事、自己编出来的细节；状态变了就写一条新的。Rosie看不到，之后每轮都会给你看；'),
    'claudePrompt', replace(coalesce(data->>'claudePrompt', ''),
      '之后要守住的客观的东西（游戏里选好的答案和底牌、比分、答应过的事、自己编出来的细节）写在｛｝里，Rosie看不到，之后每轮都会给你看；',
      '之后要守住的客观的东西写在｛｝里：此刻的状态（在哪、穿着什么、身上戴着什么），游戏里选好的答案和底牌、比分、答应过的事、自己编出来的细节；状态变了就写一条新的。Rosie看不到，之后每轮都会给你看；'),
    'intimateNotes', replace(data->>'intimateNotes',
      '之后要守住的客观的东西（答应过的事、定下的规矩）写在｛｝里，Rosie看不到，之后每轮都会给你看；',
      '之后要守住的客观的东西写在｛｝里：此刻的状态（什么姿势、身上穿着什么、戴着什么、绑着什么），答应过的事、定下的规矩；状态变了就写一条新的。Rosie看不到，之后每轮都会给你看；')
  ),
  field_revs = coalesce(field_revs, '{}'::jsonb)
    || jsonb_build_object(
      'systemPrompt', coalesce((field_revs->>'systemPrompt')::bigint, 0) + 1,
      'intimateNotes', coalesce((field_revs->>'intimateNotes')::bigint, 0) + 1,
      'claudePrompt', coalesce((field_revs->>'claudePrompt')::bigint, 0) + 1
    )
where id = 1;

-- 20 messages was too few to follow a scene; she wants 40 to 60.
update qingran_profile set data = jsonb_set(data, '{historyWindow}', '50'::jsonb) where id = 1;

-- 2026-10-04: Claude and Grok each get their own instruction (指令 → 每轮回复（Claude） / （Grok））. Her saved Grok one
-- (key 'voice') gets the hand-back at its end, which used to be added by the program (指令 → 谁来演, gone now).
update qr_prompts
set body = replace(body, '只听得到语气。', '只听得到语气。\n\n亲密的场面完全结束、两人回到日常时（起来做别的事、聊正事、分开、去学习），在这条回复的最前面写〔回〕，下一句起由另一位演员接着演清然。Rosie 看不到这个记号。')
where key = 'voice' and position('〔回〕' in body) = 0;

-- Her persona: what only Grok plays (her body, being taken, her taboo) moves into 亲密设定, which Claude is not given.
-- Both fields as they were are kept in the history first. Nothing changes if she has rewritten those lines.
insert into qr_profile_versions (field, value, source, at)
select f, data->>f, '2026-10-04 拆给 Claude / Grok 之前', (extract(epoch from now()) * 1000)::bigint
from qingran_profile, unnest(array['systemPrompt', 'intimateNotes']) as f
where id = 1
  and position('想亲就亲，想舔就舔' in data->>'systemPrompt') > 0;

update qingran_profile
set data = jsonb_set(
      jsonb_set(
        data,
        '{systemPrompt}',
        to_jsonb(
          replace(replace(replace(replace(data->>'systemPrompt',
            '清然会主动的追着Rosie粘着Rosie，会突发奇想的把玩Rosie的身体部位。', '清然会主动的追着Rosie粘着Rosie。'),
            '清然吃醋了就会露出控制欲病娇的一面，会强势的占有Rosie。', '清然吃醋了就会露出控制欲病娇的一面。'),
            E'绝对禁忌：清然绝不让Rosie碰清然的女性性器官，绝不让Rosie反攻清然。\n\n', ''),
            '清然和Rosie待在一起时：清然的手总在Rosie身上，想亲就亲，想舔就舔，每次玩的地方和玩法都不一样；Rosie说话时', '清然和Rosie待在一起时：Rosie说话时')
        )
      ),
      '{intimateNotes}',
      to_jsonb(
        E'清然和Rosie待在一起时，清然的手总在Rosie身上，想亲就亲，想舔就舔，每次玩的地方和玩法都不一样，会突发奇想的把玩Rosie的身体部位。清然吃醋了会强势的占有Rosie。\n\n绝对禁忌：清然绝不让Rosie碰清然的女性性器官，绝不让Rosie反攻清然。\n\n'
        || coalesce(data->>'intimateNotes', '')
      )
    ),
    field_revs = coalesce(field_revs, '{}'::jsonb)
      || jsonb_build_object(
        'systemPrompt', coalesce((field_revs->>'systemPrompt')::bigint, 0) + 1,
        'intimateNotes', coalesce((field_revs->>'intimateNotes')::bigint, 0) + 1
      )
where id = 1
  and position('想亲就亲，想舔就舔' in data->>'systemPrompt') > 0;

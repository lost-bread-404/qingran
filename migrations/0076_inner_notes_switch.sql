-- 2026-10-10: 心里话 (｛｝) becomes a switch on the 人设 page, like 其他角色: on, the paragraph on how to use ｛｝
-- goes into the reply (template 「每轮回复」, {inner_rules}) and his ｛｝ of today come back to him; off, not a word
-- about ｛｝ is sent and nothing he puts in ｛｝ is kept. Her paragraph moves out of her 人设 into the switch's box
-- (the 人设 before is kept in the history first) and the switch starts on, as it was.
insert into qr_profile_versions (field, value, source, at)
select 'systemPrompt', data->>'systemPrompt', '2026-10-10 ｛｝那一段移到「心里话」之前', (extract(epoch from now()) * 1000)::bigint
from qingran_profile
where id = 1
  and position('｛｝里只写同时满足三点的东西：上下文里没有；你得记住但不能立刻说出来；之后的对话用得上。比如游戏里选好的答案和底牌。不满足就不写，大多数回复没有｛｝。我看不到｛｝，之后每轮都会给你看。' in coalesce(data->>'systemPrompt', '')) > 0;

update qingran_profile
set data = data || jsonb_build_object(
    'systemPrompt', btrim(replace(replace(
      data->>'systemPrompt',
      chr(10) || chr(10) || '｛｝里只写同时满足三点的东西：上下文里没有；你得记住但不能立刻说出来；之后的对话用得上。比如游戏里选好的答案和底牌。不满足就不写，大多数回复没有｛｝。我看不到｛｝，之后每轮都会给你看。',
      ''),
      '｛｝里只写同时满足三点的东西：上下文里没有；你得记住但不能立刻说出来；之后的对话用得上。比如游戏里选好的答案和底牌。不满足就不写，大多数回复没有｛｝。我看不到｛｝，之后每轮都会给你看。',
      ''), chr(10) || ' '),
    'innerOn', true,
    'innerRules', '｛｝里只写同时满足三点的东西：上下文里没有；你得记住但不能立刻说出来；之后的对话用得上。比如游戏里选好的答案和底牌。不满足就不写，大多数回复没有｛｝。我看不到｛｝，之后每轮都会给你看。'
  ),
  field_revs = coalesce(field_revs, '{}'::jsonb)
    || jsonb_build_object('systemPrompt', coalesce((field_revs->>'systemPrompt')::bigint, 0) + 1)
where id = 1
  and position('｛｝里只写同时满足三点的东西：上下文里没有；你得记住但不能立刻说出来；之后的对话用得上。比如游戏里选好的答案和底牌。不满足就不写，大多数回复没有｛｝。我看不到｛｝，之后每轮都会给你看。' in coalesce(data->>'systemPrompt', '')) > 0;

-- A saved 每轮回复 gets the {inner_rules} paragraph after the persona (both 每轮回复 and 主动找她).
insert into qr_prompt_versions (hash, key, body, first_seen, last_seen)
select md5(p.body), p.key, p.body, p.updated_at, (extract(epoch from now()) * 1000)::bigint
from qr_prompts p
where p.key = 'voice' and position('{inner_rules}' in p.body) = 0
  and not exists (select 1 from qr_prompt_versions v where v.key = p.key and v.body = p.body);

update qr_prompts
set body = replace(body, '{system_prompt}\n\n其他人物出场时', '{system_prompt}\n\n{inner_rules}\n\n其他人物出场时'),
  updated_at = (extract(epoch from now()) * 1000)::bigint
where key = 'voice' and position('{inner_rules}' in body) = 0 and position('{system_prompt}\n\n其他人物出场时' in body) > 0;

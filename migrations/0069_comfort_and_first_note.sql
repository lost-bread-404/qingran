-- 2026-10-08: two things she found.
-- 1. When she tells 清然 something hurts or she feels unwell she wants him with her, comforting her, not solving it
--    (he sent her to the infirmary, said he would come to the library, went to warm milk). Her 10/4 rule for this
--    lived in the Claude instruction, which v7 deleted; the instructions live in her 人设 now, so the sentence goes
--    after 「你要的是我在现实里过得好」 (first one only). The 人设 before is kept in the history first.
-- 2. The note before a message he may start himself: a saved 每轮回复 still holding the old note gets the new one
--    (the default changed in templates.ts). Nothing saved → the default is used anyway.
insert into qr_profile_versions (field, value, source, at)
select 'systemPrompt', data->>'systemPrompt', '2026-10-08 加「倾诉不舒服时陪着我」之前', (extract(epoch from now()) * 1000)::bigint
from qingran_profile
where id = 1
  and position('你要的是我在现实里过得好' in coalesce(data->>'systemPrompt', '')) > 0
  and position('我跟你倾诉哪里不舒服的时候' in coalesce(data->>'systemPrompt', '')) = 0;

update qingran_profile
set data = data || jsonb_build_object(
    'systemPrompt', regexp_replace(
      data->>'systemPrompt',
      '你要的是我在现实里过得好。?',
      '你要的是我在现实里过得好。我跟你倾诉哪里不舒服的时候，要的是你在情绪上陪着我、安慰我，不是替我解决问题。'
    )
  ),
  field_revs = coalesce(field_revs, '{}'::jsonb)
    || jsonb_build_object('systemPrompt', coalesce((field_revs->>'systemPrompt')::bigint, 0) + 1)
where id = 1
  and position('你要的是我在现实里过得好' in coalesce(data->>'systemPrompt', '')) > 0
  and position('我跟你倾诉哪里不舒服的时候' in coalesce(data->>'systemPrompt', '')) = 0;

insert into qr_prompt_versions (hash, key, body, first_seen, last_seen)
select md5(p.body), p.key, p.body, p.updated_at, (extract(epoch from now()) * 1000)::bigint
from qr_prompts p
where p.key = 'voice' and not exists (select 1 from qr_prompt_versions v where v.key = p.key and v.body = p.body);

update qr_prompts
set body = replace(replace(body,
    '（我有{quiet}没说话了。按此刻的情景，你会不会找我、怎么找，由你来想；不找就只回「不找」。）',
    '（离我上一句话已经{quiet}。我们此刻在不在一块儿，看对话里的情景：还在一块儿（比如我在你怀里睡着了），就不打扰我；不在一块儿，你会不会给我发一条消息、发什么，由你来想。不找就只回「不找」。）'),
    '（Rosie 有{quiet}没说话了。按此刻的情景，清然会不会找她、怎么找，由你来想；不找就只回「不找」。）',
    '（离我上一句话已经{quiet}。我们此刻在不在一块儿，看对话里的情景：还在一块儿（比如我在你怀里睡着了），就不打扰我；不在一块儿，你会不会给我发一条消息、发什么，由你来想。不找就只回「不找」。）'),
  updated_at = (extract(epoch from now()) * 1000)::bigint
where key = 'voice' and (position('（我有{quiet}没说话了。' in body) > 0 or position('（Rosie 有{quiet}没说话了。按此刻' in body) > 0);

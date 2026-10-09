-- 2026-10-09: she wants him, before writing first, to work out from the time what she is doing now (hours after she had
-- gone to class he still asked whether she had gone). Her saved note (her own words, 10/8) gets the time in it; the
-- version before is kept in the history first.
insert into qr_prompt_versions (hash, key, body, first_seen, last_seen)
select md5(p.body), p.key, p.body, p.updated_at, (extract(epoch from now()) * 1000)::bigint
from qr_prompts p
where p.key = 'voice' and not exists (select 1 from qr_prompt_versions v where v.key = p.key and v.body = p.body);

update qr_prompts
set body = replace(replace(body,
    '（离我上一句话已经{quiet}。你通过上下文判断我们的场景和状态，判断想不想要主动找我，想的话就发你想说的话，我会看见。不想找就只回「不找」，我看不见。）',
    '（离我上一句话已经{quiet}。你通过上下文和现在的时间，推测我此刻大概在做什么，判断我们的场景和状态，再判断想不想要主动找我、怎么找；想的话就发你想说的话，我会看见。不想找就只回「不找」，我看不见。）'),
    '（离我上一句话已经{quiet}。我们此刻在不在一块儿，看对话里的情景：还在一块儿（比如我在你怀里睡着了），就不打扰我；不在一块儿，你会不会给我发一条消息、发什么，由你来想。不找就只回「不找」。）',
    '（离我上一句话已经{quiet}。你通过上下文和现在的时间，推测我此刻大概在做什么，判断我们的场景和状态，再判断想不想要主动找我、怎么找；想的话就发你想说的话，我会看见。不想找就只回「不找」，我看不见。）'),
  updated_at = (extract(epoch from now()) * 1000)::bigint
where key = 'voice' and (position('（离我上一句话已经{quiet}。你通过上下文判断我们的场景和状态，判断想不想要主动找我，想的话就发你想说的话，我会看见。不想找就只回「不找」，我看不见。）' in body) > 0 or position('（离我上一句话已经{quiet}。我们此刻在不在一块儿，看对话里的情景：还在一块儿（比如我在你怀里睡着了），就不打扰我；不在一块儿，你会不会给我发一条消息、发什么，由你来想。不找就只回「不找」。）' in body) > 0);

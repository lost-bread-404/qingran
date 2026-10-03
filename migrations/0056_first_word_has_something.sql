-- 2026-10-03: a message he starts himself says something (what she said she would do, what he is doing, what they
-- left unsaid), not just 「我在呢」. Her saved 主动找她 note gets the new wording too.
update qr_prompts
set body = replace(body, '（Rosie 放下手机{quiet}了，你们现在不在一块儿。你可以给 Rosie 发一条手机消息，接着你们上次停下的地方说；不想发，只回「不找」。）', '（Rosie 放下手机{quiet}了，你们现在不在一块儿。你想她了，可以给她发一条手机消息，说一件具体的、新的事，像真的想一个人时会发的那样：问问她之前说要去做的事怎么样了，或者告诉她你这会儿在做什么、碰到了什么让你想到她，或者把你们没说完的事接着说下去。没有想说的事，只回「不找」。）')
where key = 'voice';

-- 2026-10-03: a short, open note for a message he starts: his persona, this moment, show don't tell (a list of what
-- to say got filled in like a form: 「很想你……现在想我了吗？」). Her saved note too.
update qr_prompts
set body = replace(body, '（Rosie 放下手机{quiet}了，你们现在不在一块儿。你想她了，可以给她发一条手机消息，说一件具体的、新的事，像真的想一个人时会发的那样：问问她之前说要去做的事怎么样了，或者告诉她你这会儿在做什么、碰到了什么让你想到她，或者把你们没说完的事接着说下去。没有想说的事，只回「不找」。）', '（Rosie 放下手机{quiet}了，你们现在不在一块儿。照着人设，此刻的清然会不会给她发一条手机消息、发什么，由你来想；要合此刻的情景，show, don''t tell。不发，只回「不找」。）')
where key = 'voice';

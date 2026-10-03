-- 2026-10-02: other people in the scene. Her saved reply prompt (both 每轮回复 and 主动找她) gets the same two lines
-- the default got: 「名字：」 blocks in that person's first person, and 清然 only knows what he was there for.
update qr_prompts
set body = replace(
  body,
  '守规则。\n朗读你的话时',
  '守规则。\n别人出场时，另起一段用「名字：」开头，比如「林泽：」，那一段用他的第一人称写他做的、他看到的 Rosie 和他说的话；回到你时另起一段用「清然：」开头。只有你们俩时不用写名字。\n你只知道你在场时看到、听到的；你不在的时候发生的事，有人告诉你，你才知道。\n朗读你的话时'
)
where key = 'voice' and body not like '%别人出场时%';

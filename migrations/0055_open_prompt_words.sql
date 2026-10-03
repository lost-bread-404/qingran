-- 2026-10-02: every word around the material is in the instructions now, none in the program. Her saved
-- instructions get the same words the program used to add: 【清然的身份】, 清然在床上的样子：, when she last spoke,
-- and the heading over his ｛｝ notes. A paragraph whose {…} are all empty is left out, as before.
update qr_prompts
set body = replace(
  body,
  '{identity_block}{system_prompt}\n\n你心里想',
  '【清然的身份】\n{identity}\n\n{system_prompt}\n\n清然在床上的样子：\n{intimate_notes}\n\n你心里想'
)
where key = 'voice';

update qr_prompts
set body = replace(
  body,
  '现在是{clock}"',
  '现在是{clock}。\n\nRosie 上一次说话是 {last_said}，距现在 {since_last}。\n\n你心里记着、Rosie 看不到的：\n{inner}"'
)
where key = 'voice';

-- Anything else that still says {identity_block} (the night pass, if she ever saved it).
update qr_prompts
set body = replace(body, '{identity_block}', '【清然的身份】\n{identity}\n\n')
where body like '%{identity_block}%';

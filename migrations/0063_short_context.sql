-- 2026-10-04: she asked for a short prompt in which every line counts. Of the 14,700 characters Grok was given at
-- 14:13, 7,400 were his own 32 earlier replies (which he then copied, 「说你是我的」 over and over) and 4,300 all of
-- their past. The talk is now the last N messages (she can change it on 设置 → 回复), N = 20 to start with.
update qingran_profile set data = jsonb_set(data, '{historyWindow}', '20'::jsonb) where id = 1;

-- The 10/1 moment read like a standing order (「她要的是直接、肯定的回答」), and he reassured her every turn. It is
-- told as what happened that night; its vector is made again from the new words.
update qr_memories
set body = '10月1日晚上Rosie不安，反复问清然喜不喜欢她叫姐姐、她是不是清然的小宝贝、清然会不会不要她、是不是真的爱她；清然每次都直接、肯定地回答了她。',
    kind = 'moment', vec = null, vec_model = '', updated_at = (extract(epoch from now()) * 1000)::bigint
where id = 145 and body like 'Rosie不安的时候会反复确认%';

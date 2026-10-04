-- 2026-10-04: she found the reply instructions full of patches and the model dull because of them. The defaults are
-- rewritten short (who 清然 is lives in her persona; the instruction keeps only how a reply is written and the
-- handover). Her saved 每轮回复（Grok） is a patched copy of the old default, so it goes back to the new default.
-- Its text stays in the version history.
insert into qr_prompt_versions (hash, key, body, first_seen, last_seen)
select md5(p.body), p.key, p.body, p.updated_at, (extract(epoch from now()) * 1000)::bigint
from qr_prompts p
where p.key = 'voice' and not exists (select 1 from qr_prompt_versions v where v.key = p.key and v.body = p.body);

delete from qr_prompts where key = 'voice';

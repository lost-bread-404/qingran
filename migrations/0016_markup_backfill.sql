-- Idempotent: main wrote messages after 0003_v2, so prefixes may still sit in body.
-- Same conversion as 0003_v2. Hearing markers (听/气/回/未听/断) stay in body.
update qingran_messages
set archived_at = coalesce(archived_at, created_at)
where archived_at is null
  and (body like '⟦已扫⟧%' or body like E'\\u27e6已扫\\u27e7%');

update qingran_messages
set kind = 'steer'
where kind = 'say'
  and (body like '%⟦走向⟧%' or body like '⟦走向⟧%' or body like '⟦已扫⟧⟦走向⟧%');

update qingran_messages
set kind = 'setting'
where kind = 'say'
  and (body like '%⟦设定⟧%' or body like '⟦设定⟧%' or body like '⟦已扫⟧⟦设定⟧%');

update qingran_messages
set body = regexp_replace(body, '^⟦已扫⟧', '')
where body like '⟦已扫⟧%';

update qingran_messages
set body = regexp_replace(body, '^⟦走向⟧', '')
where body like '⟦走向⟧%';

update qingran_messages
set body = regexp_replace(body, '^⟦设定⟧', '')
where body like '⟦设定⟧%';

update qingran_messages
set local_day = to_char(to_timestamp(created_at / 1000.0) - interval '4 hours', 'YYYY-MM-DD')
where local_day is null;

update qingran_messages
set session_id = 'd:' || local_day
where session_id is null and local_day is not null;

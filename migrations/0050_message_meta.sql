-- 2026-10-02: a message's words and what is known about it are kept apart. Until now the facts (which line it
-- answers, which page she picked, which recording it came from, photos, interrupted, …) were glued to the front of
-- the text as ⟦…⟧ marks, and every reader had to peel them off. Now `body` is only the words and `meta` holds the rest.
alter table qingran_messages add column if not exists meta jsonb not null default '{}'::jsonb;

do $$
declare
  r record;
  b text;
  m jsonb;
  tok text;
begin
  for r in select id, body from qingran_messages where body like '⟦%' loop
    b := r.body;
    m := '{}'::jsonb;
    loop
      tok := substring(b from '^⟦([^⟧]*)⟧');
      exit when tok is null;
      if tok like '选:%' then m := m || jsonb_build_object('activeReply', substr(tok, 3));
      elsif tok = '夜噪' then m := m || '{"nightNoise": true}'::jsonb;
      elsif tok = '断' then m := m || '{"interrupted": true}'::jsonb;
      elsif tok = '已扫' then m := m || '{"scanned": true}'::jsonb;
      elsif tok like '听:%:金' then
        m := m || jsonb_build_object('voiceTurnId', substr(tok, 3, char_length(tok) - 4), 'hearingGold', 'confirmed');
      elsif tok like '听:%' then m := m || jsonb_build_object('voiceTurnId', substr(tok, 3));
      elsif tok like '气:%' then m := m || jsonb_build_object('predicted', substr(tok, 3));
      elsif tok like '回:%' then m := m || jsonb_build_object('replyTo', substr(tok, 3));
      elsif tok = '未听' then m := m || '{"unheard": true}'::jsonb;
      elsif tok like '图:%' then m := m || jsonb_build_object('images', to_jsonb(string_to_array(substr(tok, 3), ',')));
      elsif tok = '走向' or tok = '设定' then null;
      else exit;
      end if;
      b := substr(b, char_length(tok) + 3);
    end loop;
    update qingran_messages set body = b, meta = m where id = r.id;
  end loop;
end $$;

create index if not exists qingran_messages_reply_to_idx on qingran_messages ((meta->>'replyTo'));

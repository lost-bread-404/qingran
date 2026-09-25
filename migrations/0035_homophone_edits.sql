-- When Rosie edits her own message and swaps a word for a same-sounding one, keep the pair
-- so she can decide later whether to add it to the xAI keyterms.
create table if not exists qr_homophone_edits (
  id bigserial primary key,
  at bigint not null,
  message_id text not null,
  wrong text not null,
  correct text not null,
  before text not null,
  after text not null
);
create index if not exists qr_homophone_edits_at_idx on qr_homophone_edits (at desc);

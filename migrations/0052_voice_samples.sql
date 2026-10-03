-- 2026-10-02: one recording of the same Chinese line in each xAI voice, for picking a voice for a new character.
create table if not exists qr_voice_samples (
  voice_id text primary key,
  line text not null,
  wav text not null,
  made_at bigint not null
);

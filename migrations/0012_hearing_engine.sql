alter table qingran_hearing_turns
  add column if not exists engine_requested text,
  add column if not exists engine_used text,
  add column if not exists audio_llm_ms integer,
  add column if not exists engine_fallback_reason text;

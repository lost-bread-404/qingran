-- 2026-09-26: her SuperGrok subscription pays first, the API key after it (src/lib/lover/xai-auth.ts).
create table if not exists qr_xai_login (
  id int primary key default 1,
  access_token text,
  refresh_token text,
  expires_at bigint,
  device_code text,
  user_code text,
  verify_url text,
  device_expires_at bigint,
  poll_interval int,
  refused_until bigint,
  refused_note text,
  updated_at bigint
);
insert into qr_xai_login (id) values (1) on conflict (id) do nothing;

-- 2026-10-02: photos Rosie sends 清然. Shrunk on her phone (longest side 1024, JPEG) before upload; the message
-- body says which ones with ⟦图:id,id⟧. The reply model sees the photos of the last few photo messages.
create table if not exists qr_photos (
  id text primary key,
  mime text not null,
  data text not null,          -- base64
  bytes integer not null,
  created_at bigint not null
);

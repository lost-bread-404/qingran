import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { VoiceChatMessage } from "./brain/types.ts";

/**
 * Photos Rosie sends 清然 (requirements 第 6 节). The phone shrinks each one before upload; here they are kept
 * whole in `qr_photos` and handed to the reply model as images (Grok reads JPG / PNG).
 */

/** A photo bigger than this after shrinking is refused (the request limit is about 4.5 MB). */
const MAX_BYTES = 3_000_000;
/** The reply sees the photos of this many of her most recent photo messages; older ones are just「发来一张照片」. */
export const PHOTO_TURNS = 3;

const DATA_URL = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/;

export async function savePhoto(dataUrl: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const m = DATA_URL.exec(dataUrl);
  if (!m) return { ok: false, error: "只能发 JPG 或 PNG 照片。" };
  const bytes = Math.floor((m[2]!.length * 3) / 4);
  if (bytes > MAX_BYTES) return { ok: false, error: "照片太大了。" };
  const id = randomUUID();
  const sql = await getSql();
  await sql`insert into qr_photos (id, mime, data, bytes, created_at) values (${id}, ${m[1]!}, ${m[2]!}, ${bytes}, ${Date.now()})`;
  return { ok: true, id };
}

export async function loadPhoto(id: string): Promise<{ mime: string; data: string } | null> {
  const sql = await getSql();
  const rows = await sql<{ mime: string; data: string }>`select mime, data from qr_photos where id = ${id}`;
  return rows[0] ?? null;
}

async function loadPhotoUrls(ids: string[]): Promise<Map<string, string>> {
  const db = await getSql();
  const rows = await db.query<{ id: string; mime: string; data: string }>(
    `select id, mime, data from qr_photos where id = any($1::text[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, `data:${r.mime};base64,${r.data}`]));
}

type XaiPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" } };
export type XaiMessage = { role: VoiceChatMessage["role"]; content: string | XaiPart[] };

/**
 * The messages as xAI takes them: her last few photo messages carry their photos, everything else is text (the
 * text already says a photo was sent). A photo that cannot be read is left out; the words still go.
 */
export async function withPhotos(messages: VoiceChatMessage[]): Promise<XaiMessage[]> {
  const carry = new Set<number>();
  for (let i = messages.length - 1; i >= 0 && carry.size < PHOTO_TURNS; i -= 1) {
    if (messages[i]!.role === "user" && messages[i]!.images?.length) carry.add(i);
  }
  const ids = [...carry].flatMap((i) => messages[i]!.images ?? []);
  const urls = ids.length ? await loadPhotoUrls(ids).catch(() => new Map<string, string>()) : new Map<string, string>();
  return messages.map((m, i) => {
    const photos = carry.has(i) ? (m.images ?? []).map((id) => urls.get(id)).filter((u): u is string => Boolean(u)) : [];
    if (!photos.length) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        ...photos.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } })),
        { type: "text" as const, text: m.content },
      ],
    };
  });
}

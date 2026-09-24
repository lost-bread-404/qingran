import { getSql } from "../../../db.ts";
import { now } from "../clock.ts";
import { sha256Text } from "../log-refs.ts";
import {
  isPromptKey,
  promptKeys,
  promptSpec,
  type PromptKey,
  type PromptSpec,
} from "./catalog.ts";
import { defaultDoc, parsePromptBody, serializeDoc, type PromptDoc } from "./doc.ts";

export type PromptVersionHit = {
  hash: string;
  lastSeen: number;
};

export type LoadedPrompt = {
  key: PromptKey;
  body: string;
  hash: string;
  custom: boolean;
  updatedAt: number | null;
  doc: PromptDoc;
};

type Cache = { bodies: Map<PromptKey, { body: string; updatedAt: number }>; loadedAt: number };
let cache: Cache | null = null;

export function resetPromptCache() {
  cache = null;
}

function stripAcousticGuide(text: string): string {
  return text
    .replace(/Rosie 的话有时会带语气标记[\s\S]*?没有标记就按普通口语听。\s*/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function materialize(key: PromptKey, raw: string | null): { body: string; doc: PromptDoc; custom: boolean; hash: string } {
  const doc = parsePromptBody(key, raw);
  if (key === "voice") {
    for (const variant of doc.variants) {
      for (const message of variant.messages) {
        message.content = stripAcousticGuide(message.content);
      }
    }
  }
  const body = serializeDoc(doc);
  return {
    body,
    doc,
    custom: body !== serializeDoc(defaultDoc(key)),
    hash: sha256Text(body),
  };
}

async function rememberVersion(key: PromptKey, body: string, hash: string, ts: number): Promise<void> {
  try {
    const db = await getSql();
    await db.query(
      `insert into qr_prompt_versions (hash, key, body, first_seen, last_seen)
       values ($1,$2,$3,$4,$4)
       on conflict (hash) do update set last_seen = excluded.last_seen, key = excluded.key`,
      [hash, key, body, ts],
    );
  } catch {
    /* logging / talk must not break if versions table is missing */
  }
}

async function readOverrides(): Promise<Map<PromptKey, { body: string; updatedAt: number }>> {
  const out = new Map<PromptKey, { body: string; updatedAt: number }>();
  try {
    const db = await getSql();
    const rows = await db.query<{ key: string; body: string; updated_at: number | string }>(
      `select key, body, updated_at from qr_prompts`,
    );
    for (const row of rows) {
      if (!isPromptKey(row.key)) continue;
      out.set(row.key, { body: String(row.body ?? ""), updatedAt: Number(row.updated_at) || 0 });
    }
  } catch {
    return out;
  }
  return out;
}

async function ensureCache(): Promise<Cache> {
  if (cache) return cache;
  const bodies = await readOverrides();
  cache = { bodies, loadedAt: now() };
  return cache;
}

export async function loadPrompt(key: PromptKey): Promise<LoadedPrompt> {
  const hit = (await ensureCache()).bodies.get(key);
  const raw = hit?.body?.trim() ? hit.body : null;
  const made = materialize(key, raw);
  void rememberVersion(key, made.body, made.hash, now());
  return {
    key,
    body: made.body,
    hash: made.hash,
    custom: made.custom,
    updatedAt: hit?.updatedAt ?? null,
    doc: made.doc,
  };
}

export async function loadPromptBody(key: PromptKey): Promise<string> {
  return (await loadPrompt(key)).body;
}

export async function getPromptVersion(hash: string): Promise<string | null> {
  try {
    const db = await getSql();
    const rows = await db.query<{ body: string }>(`select body from qr_prompt_versions where hash = $1`, [hash]);
    return rows[0]?.body ?? null;
  } catch {
    return null;
  }
}

export async function listPromptVersions(key: PromptKey, limit = 5): Promise<PromptVersionHit[]> {
  try {
    const db = await getSql();
    const rows = await db.query<{ hash: string; last_seen: number | string }>(
      `select hash, last_seen from qr_prompt_versions where key = $1 order by last_seen desc limit $2`,
      [key, Math.max(limit, 1) + 1],
    );
    return rows.slice(0, limit + 1).map((row) => ({
      hash: String(row.hash),
      lastSeen: Number(row.last_seen) || 0,
    }));
  } catch {
    return [];
  }
}

export type PromptListItem = PromptSpec & {
  body: string;
  hash: string;
  custom: boolean;
  updatedAt: number | null;
  doc: PromptDoc;
  versions: PromptVersionHit[];
};

export async function listPrompts(): Promise<PromptListItem[]> {
  await ensureCache();
  const items: PromptListItem[] = [];
  for (const key of promptKeys()) {
    const spec = promptSpec(key);
    const loaded = await loadPrompt(key);
    const versions = await listPromptVersions(key, 5);
    items.push({
      ...spec,
      body: loaded.body,
      hash: loaded.hash,
      custom: loaded.custom,
      updatedAt: loaded.updatedAt,
      doc: loaded.doc,
      versions,
    });
  }
  return items;
}

export async function savePrompt(key: PromptKey, body: string): Promise<LoadedPrompt> {
  const made = materialize(key, body);
  const ts = now();
  const db = await getSql();
  await db.query(
    `insert into qr_prompts (key, body, updated_at)
     values ($1,$2,$3)
     on conflict (key) do update set body = excluded.body, updated_at = excluded.updated_at`,
    [key, made.body, ts],
  );
  resetPromptCache();
  await rememberVersion(key, made.body, made.hash, ts);
  return { key, body: made.body, hash: made.hash, custom: made.custom, updatedAt: ts, doc: made.doc };
}

export async function restorePrompt(key: PromptKey): Promise<LoadedPrompt> {
  const db = await getSql();
  await db.query(`delete from qr_prompts where key = $1`, [key]);
  resetPromptCache();
  return loadPrompt(key);
}

export async function rollbackPrompt(key: PromptKey, hash: string): Promise<LoadedPrompt> {
  const db = await getSql();
  const rows = await db.query<{ body: string }>(
    `select body from qr_prompt_versions where hash = $1 and key = $2`,
    [hash, key],
  );
  const body = rows[0]?.body;
  if (!body) throw new Error("missing-version");
  return savePrompt(key, body);
}

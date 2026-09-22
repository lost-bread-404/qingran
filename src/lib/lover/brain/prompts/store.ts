import { getSql } from "../../../db.ts";
import { now } from "../clock.ts";
import { sha256Text } from "../log-refs.ts";
import {
  defaultPrompt,
  isPromptKey,
  promptKeys,
  promptSpec,
  type PromptKey,
  type PromptSpec,
} from "./catalog.ts";

export type LoadedPrompt = {
  key: PromptKey;
  body: string;
  hash: string;
  custom: boolean;
  updatedAt: number | null;
};

type Cache = { bodies: Map<PromptKey, { body: string; updatedAt: number }>; loadedAt: number };
let cache: Cache | null = null;

export function resetPromptCache() {
  cache = null;
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
  const fallback = defaultPrompt(key);
  const hit = (await ensureCache()).bodies.get(key);
  const body = hit?.body?.trim() ? hit.body : fallback;
  const hash = sha256Text(body);
  void rememberVersion(key, body, hash, now());
  return {
    key,
    body,
    hash,
    custom: Boolean(hit?.body && hit.body !== fallback),
    updatedAt: hit?.updatedAt ?? null,
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

export type PromptListItem = PromptSpec & {
  body: string;
  hash: string;
  custom: boolean;
  updatedAt: number | null;
};

export async function listPrompts(): Promise<PromptListItem[]> {
  await ensureCache();
  const items: PromptListItem[] = [];
  for (const key of promptKeys()) {
    const spec = promptSpec(key);
    const loaded = await loadPrompt(key);
    items.push({ ...spec, body: loaded.body, hash: loaded.hash, custom: loaded.custom, updatedAt: loaded.updatedAt });
  }
  return items;
}

export async function savePrompt(key: PromptKey, body: string): Promise<LoadedPrompt> {
  const text = body.replace(/\r\n/g, "\n");
  const ts = now();
  const db = await getSql();
  await db.query(
    `insert into qr_prompts (key, body, updated_at)
     values ($1,$2,$3)
     on conflict (key) do update set body = excluded.body, updated_at = excluded.updated_at`,
    [key, text, ts],
  );
  resetPromptCache();
  const hash = sha256Text(text);
  await rememberVersion(key, text, hash, ts);
  return { key, body: text, hash, custom: text !== defaultPrompt(key), updatedAt: ts };
}

export async function restorePrompt(key: PromptKey): Promise<LoadedPrompt> {
  const db = await getSql();
  await db.query(`delete from qr_prompts where key = $1`, [key]);
  resetPromptCache();
  return loadPrompt(key);
}

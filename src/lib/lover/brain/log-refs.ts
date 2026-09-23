import { createHash } from "node:crypto";
import { getSql } from "../../db.ts";
import { now } from "./clock.ts";
import { getMeta, patchMeta } from "./store.ts";
import { clipLogJson } from "./log-clip.ts";
import { resolveTz } from "./tz.ts";

export const HIGH_FREQ_ROUTES = new Set(["voice", "reflect", "archive"]);

export type VoiceRefs = {
  charterHash: string;
  longtermHash: string;
  historyIds: string[];
  mindTurnSeq: number;
  mindStale: boolean;
  pickedIds: string[];
  fallbackIds: string[];
  queryIds: string[];
  queryScores: number[];
  jump: boolean;
  jumpScore: number;
  careHint: boolean;
  clockText: string;
  userMsgId: string;
  timeZone: string;
  mindAgeMs: number;
  injectMemories?: boolean;
  injectLongterm?: boolean;
  historyWindow?: number;
};

export type ReflectRefs = {
  charterHash: string;
  blockBHash: string;
  relatedIds: string[];
  oldMindTurnSeq: number;
  recentMessageIds: string[];
  clockText: string;
  timeZone: string;
};

export type ArchiveRefs = {
  batchMessageIds: string[];
  candidateNoteIds: string[];
};

export function codeVersion(): string {
  return process.env.VERCEL_GIT_COMMIT_SHA || "dev";
}

export function xaiStoreEnabled(): boolean {
  return process.env.QR_XAI_STORE === "true";
}

export function logRawHours(): number {
  const n = Number(process.env.QR_LOG_RAW_HOURS ?? "0");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type HashCache = { hash: string; text: string };
const charterCache: HashCache = { hash: "", text: "" };
const blockCache = new Map<string, HashCache>();

export function resetLogRefCache() {
  charterCache.hash = "";
  charterCache.text = "";
  blockCache.clear();
}

export async function rememberCharter(text: string): Promise<string> {
  const hash = sha256Text(text);
  if (charterCache.hash === hash) return hash;
  const ts = now();
  const db = await getSql();
  await db.query(
    `insert into qr_charter_versions (hash, text, first_seen, last_seen)
     values ($1,$2,$3,$3)
     on conflict (hash) do update set last_seen = excluded.last_seen`,
    [hash, text, ts],
  );
  charterCache.hash = hash;
  charterCache.text = text;
  return hash;
}

export async function rememberBlock(kind: "voice_longterm" | "reflect_b", text: string): Promise<string> {
  const hash = sha256Text(text);
  const prev = blockCache.get(kind);
  if (prev?.hash === hash) return hash;
  const ts = now();
  const db = await getSql();
  await db.query(
    `insert into qr_block_snapshots (hash, kind, text, first_seen, last_seen)
     values ($1,$2,$3,$4,$4)
     on conflict (hash) do update set last_seen = excluded.last_seen, kind = excluded.kind`,
    [hash, kind, text, ts],
  );
  blockCache.set(kind, { hash, text });
  return hash;
}

export async function getCharterByHash(hash: string): Promise<string | null> {
  if (charterCache.hash === hash) return charterCache.text;
  const db = await getSql();
  const rows = await db.query<{ text: string }>(`select text from qr_charter_versions where hash = $1`, [hash]);
  return rows[0]?.text ?? null;
}

export async function getBlockByHash(hash: string): Promise<{ kind: string; text: string } | null> {
  for (const [kind, c] of blockCache) {
    if (c.hash === hash) return { kind, text: c.text };
  }
  const db = await getSql();
  const rows = await db.query<{ kind: string; text: string }>(
    `select kind, text from qr_block_snapshots where hash = $1`,
    [hash],
  );
  return rows[0] ?? null;
}

export async function maybeWriteRawLog(logId: number | null, input: unknown): Promise<void> {
  if (!logId) return;
  try {
    const db = await getSql();
    const clipped = clipLogJson(input);
    await db.query(`insert into brain_log_raw (log_id, input, at) values ($1,$2::jsonb,$3) on conflict (log_id) do nothing`, [
      logId,
      clipped.value,
      now(),
    ]);
    if (clipped.truncated) {
      await db.query(`update brain_log set trimmed = true where id = $1`, [logId]);
    }
  } catch (err) {
    console.error("[log-raw] write failed", err);
  }
}

export async function syncTalkTimeZone(requested?: string | null): Promise<string> {
  const meta = await getMeta();
  const want = (requested ?? "").trim();
  const tz = want || resolveTz(meta.timeZone);
  if (meta.timeZone !== tz) await patchMeta({ timeZone: tz });
  return tz;
}

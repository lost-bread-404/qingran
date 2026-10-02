import { createHash } from "node:crypto";
import { getSql } from "../../db.ts";
import { now } from "./clock.ts";
import { getMeta, patchMeta } from "./store.ts";
import { clipLogJson } from "./log-clip.ts";
import { resolveTz } from "./tz.ts";

/** What one reply was given, for the log. */
export type VoiceRefs = {
  charterHash: string;
  longtermHash: string;
  historyIds: string[];
  /** The moments that came back to him (ids), and how well the best ones fit. */
  pickedIds: string[];
  queryScores: Array<{ id: number; score: number }>;
  clockText: string;
  userMsgId: string;
  timeZone: string;
  injectMemory?: boolean;
  historyWindow?: number;
  /** Found by meaning or by words ("none" with memory off). */
  recallBy?: string;
  /** The moments that came back to him, first 200 characters each (for looking back at a turn she liked). */
  recalled?: string[];
  personaPlacement?: "system" | "first_user";
  /** Filled in when the turn is logged: how the turn went. */
  localDay?: string;
  packMs?: number;
  dbFirstMs?: number;
  ttftMs?: number | null;
  firstAudioMs?: number | null;
  personaMissing?: boolean;
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

export async function rememberBlock(kind: "voice_longterm", text: string): Promise<string> {
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

/**
 * Qingran backup v2. Lives in brain/ so it does not collide with
 * ios-microphone's src/lib/lover/backup.ts (v1).
 */
import { getSql } from "../../db.ts";
import { lockedProfile, type Profile } from "../types.ts";
import { now } from "./clock.ts";
import { enqueue } from "./jobs.ts";
import { bumpNotesVersion, pgTextArray } from "./store.ts";
import { localDay, sessionIdFor } from "./time.ts";
import { resetRetrieveCache } from "./voice/retrieve.ts";
import { BACKUP_KIND, IMPORT_ORDER } from "./backup-public.ts";

export { BACKUP_KIND, IMPORT_ORDER };
export const BACKUP_VERSION = 2;
const PAGE_BYTES = 750_000;

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export type BackupRow = { [key: string]: Json };
export type BackupCursor = { table: string; after: string[] };

type ColKind = "text" | "int" | "bool" | "json" | "text[]" | "num" | "real" | "real[]";

export type TableSpec = {
  name: string;
  pk: string[];
  columns: Array<[string, ColKind]>;
};

/** Export order (spec §4.1). Import order is IMPORT_ORDER. */
export const BACKUP_TABLES: TableSpec[] = [
  {
    name: "qingran_messages",
    pk: ["id"],
    columns: [
      ["id", "text"],
      ["role", "text"],
      ["body", "text"],
      ["created_at", "int"],
      ["kind", "text"],
      ["archived_at", "int"],
      ["forgotten_at", "int"],
      ["session_id", "text"],
      ["local_day", "text"],
      ["edited_at", "int"],
    ],
  },
  {
    name: "mem_notes",
    pk: ["id"],
    columns: [
      ["id", "text"],
      ["text", "text"],
      ["tags", "text[]"],
      ["aliases", "text[]"],
      ["subject", "text"],
      ["lens", "text[]"],
      ["from_rosie", "bool"],
      ["weight", "int"],
      ["status", "text"],
      ["superseded_by", "text"],
      ["links", "text[]"],
      ["happened_at", "int"],
      ["local_day", "text"],
      ["source_ids", "text[]"],
      ["recall_count", "int"],
      ["last_recalled_at", "int"],
      ["created_at", "int"],
      ["updated_at", "int"],
      ["batch_key", "text"],
      ["supersedes", "text"],
    ],
  },
  {
    name: "mem_history",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["table_name", "text"],
      ["row_id", "text"],
      ["op", "text"],
      ["before", "json"],
      ["after", "json"],
      ["job_id", "text"],
      ["at", "int"],
    ],
  },
  {
    name: "qr_portrait",
    pk: ["id"],
    columns: [
      ["id", "text"],
      ["topic", "text"],
      ["body", "text"],
      ["status", "text"],
      ["kind", "text"],
      ["evidence_ids", "text[]"],
      ["last_seen", "int"],
      ["last_supported_at", "int"],
      ["support_count", "int"],
      ["updated_at", "int"],
    ],
  },
  {
    name: "qr_mind",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["data", "json"],
      ["turn_seq", "int"],
      ["updated_at", "int"],
    ],
  },
  {
    name: "brain_meta",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["data", "json"],
    ],
  },
  {
    name: "diary_days",
    pk: ["day"],
    columns: [
      ["day", "text"],
      ["summary", "text"],
      ["energy", "int"],
      ["mood", "int"],
      ["body", "text"],
      ["did", "json"],
      ["avoided", "json"],
      ["events", "json"],
      ["wins", "json"],
      ["first_active", "int"],
      ["last_active", "int"],
      ["msg_count", "int"],
      ["coverage", "text"],
      ["note_ids", "text[]"],
      ["version", "int"],
      ["updated_at", "int"],
    ],
  },
  {
    name: "diary_intentions",
    pk: ["id"],
    columns: [
      ["id", "text"],
      ["text", "text"],
      ["tag", "text"],
      ["stated_at", "int"],
      ["target_day", "text"],
      ["status", "text"],
      ["started_at", "int"],
      ["done_at", "int"],
      ["last_evidence_at", "int"],
      ["evidence_ids", "text[]"],
      ["updated_at", "int"],
    ],
  },
  {
    name: "diary_factors",
    pk: ["id"],
    columns: [
      ["id", "text"],
      ["name", "text"],
      ["definition", "text"],
      ["version", "int"],
      ["is_outcome", "bool"],
      ["status", "text"],
      ["origin", "text"],
      ["user_feedback", "text"],
      ["created_at", "int"],
      ["updated_at", "int"],
    ],
  },
  {
    name: "diary_day_factors",
    pk: ["day", "factor_id"],
    columns: [
      ["day", "text"],
      ["factor_id", "text"],
      ["version", "int"],
      ["value", "int"],
      ["evidence_ids", "text[]"],
    ],
  },
  {
    name: "diary_themes",
    pk: ["id"],
    columns: [
      ["id", "text"],
      ["name", "text"],
      ["definition", "text"],
      ["version", "int"],
      ["status", "text"],
      ["merged_into", "text"],
      ["parent_id", "text"],
      ["user_feedback", "text"],
      ["created_at", "int"],
      ["updated_at", "int"],
    ],
  },
  {
    name: "diary_theme_members",
    pk: ["theme_id", "note_id"],
    columns: [
      ["theme_id", "text"],
      ["note_id", "text"],
      ["version", "int"],
    ],
  },
  {
    name: "diary_theme_weeks",
    pk: ["theme_id", "week"],
    columns: [
      ["theme_id", "text"],
      ["week", "text"],
      ["mentions", "int"],
      ["action_taken", "int"],
      ["mood_avg", "num"],
    ],
  },
  {
    name: "diary_episodes",
    pk: ["id"],
    columns: [
      ["id", "text"],
      ["factor_id", "text"],
      ["start_day", "text"],
      ["end_day", "text"],
      ["end_known", "bool"],
      ["days", "int"],
      ["evidence_ids", "text[]"],
      ["computed_at", "int"],
    ],
  },
  {
    name: "diary_findings",
    pk: ["id"],
    columns: [
      ["id", "text"],
      ["kind", "text"],
      ["outcome_id", "text"],
      ["antecedent_id", "text"],
      ["lag", "int"],
      ["n11", "int"],
      ["n10", "int"],
      ["n01", "int"],
      ["n00", "int"],
      ["lift", "num"],
      ["score", "num"],
      ["example_days", "text[]"],
      ["counter_days", "text[]"],
      ["user_feedback", "text"],
      ["computed_at", "int"],
      ["tier", "text"],
    ],
  },
  {
    name: "diary_experiments",
    pk: ["id"],
    columns: [
      ["id", "text"],
      ["hypothesis", "text"],
      ["action", "text"],
      ["outcome_id", "text"],
      ["compliance_factor_id", "text"],
      ["start_day", "text"],
      ["end_day", "text"],
      ["status", "text"],
      ["result", "json"],
      ["created_at", "int"],
    ],
  },
  {
    name: "diary_reports",
    pk: ["id"],
    columns: [
      ["id", "text"],
      ["period_start", "text"],
      ["period_end", "text"],
      ["data", "json"],
      ["narrative", "text"],
      ["created_at", "int"],
    ],
  },
  {
    name: "brain_turns",
    pk: ["turn_seq"],
    columns: [
      ["turn_seq", "int"],
      ["user_msg_id", "text"],
      ["reply_msg_id", "text"],
      ["local_day", "text"],
      ["session_id", "text"],
      ["mind_turn_seq", "int"],
      ["mind_age_ms", "int"],
      ["mind_stale", "bool"],
      ["picked_ids", "text[]"],
      ["fallback_ids", "text[]"],
      ["query_ids", "text[]"],
      ["query_scores", "real[]"],
      ["jump", "bool"],
      ["jump_score", "real"],
      ["care_hint", "bool"],
      ["tail", "text"],
      ["reply_chars", "int"],
      ["pack_ms", "int"],
      ["db_first_ms", "int"],
      ["ttft_ms", "int"],
      ["first_audio_ms", "int"],
      ["total_ms", "int"],
      ["voice_model", "text"],
      ["reflect_ok", "bool"],
      ["reflect_ms", "int"],
      ["reflect_error", "text"],
      ["feedback", "text"],
      ["created_at", "int"],
      ["code_version", "text"],
      ["charter_hash", "text"],
      ["longterm_hash", "text"],
      ["history_ids", "text[]"],
      ["clock_text", "text"],
    ],
  },
  {
    name: "qr_mind_history",
    pk: ["turn_seq"],
    columns: [
      ["turn_seq", "int"],
      ["data", "json"],
      ["model", "text"],
      ["ms", "int"],
      ["created_at", "int"],
    ],
  },
  {
    name: "brain_daily_digest",
    pk: ["day"],
    columns: [
      ["day", "text"],
      ["data", "json"],
      ["markdown", "text"],
      ["updated_at", "int"],
    ],
  },
  {
    name: "spend_events",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["at", "int"],
      ["day", "text"],
      ["month", "text"],
      ["kind", "text"],
      ["route", "text"],
      ["model", "text"],
      ["tokens_in", "int"],
      ["tokens_cached", "int"],
      ["tokens_out", "int"],
      ["tokens_reasoning", "int"],
      ["chars", "int"],
      ["seconds", "num"],
      ["usd", "num"],
      ["estimated", "bool"],
      ["turn_seq", "int"],
      ["job_id", "text"],
      ["log_id", "int"],
      ["usd_est", "num"],
      ["cost_source", "text"],
    ],
  },
  {
    name: "spend_daily",
    pk: ["day", "route"],
    columns: [
      ["day", "text"],
      ["route", "text"],
      ["usd", "num"],
      ["calls", "int"],
    ],
  },
  {
    name: "spend_alerts",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["at", "int"],
      ["day", "text"],
      ["month", "text"],
      ["scope", "text"],
      ["level", "text"],
      ["total_usd", "num"],
      ["detail", "text"],
    ],
  },
  {
    name: "spend_reconcile",
    pk: ["month"],
    columns: [
      ["month", "text"],
      ["actual_usd", "num"],
      ["estimated_usd", "num"],
      ["entered_at", "int"],
    ],
  },
  {
    name: "spend_overrides",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["scope", "text"],
      ["period", "text"],
      ["created_at", "int"],
      ["note", "text"],
    ],
  },
  {
    name: "qr_charter_versions",
    pk: ["hash"],
    columns: [
      ["hash", "text"],
      ["text", "text"],
      ["first_seen", "int"],
      ["last_seen", "int"],
    ],
  },
  {
    name: "qr_block_snapshots",
    pk: ["hash"],
    columns: [
      ["hash", "text"],
      ["kind", "text"],
      ["text", "text"],
      ["first_seen", "int"],
      ["last_seen", "int"],
    ],
  },
  {
    name: "qingran_message_edits",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["message_id", "text"],
      ["before", "text"],
      ["at", "int"],
    ],
  },
  {
    name: "spend_monthly",
    pk: ["month", "route", "model"],
    columns: [
      ["month", "text"],
      ["route", "text"],
      ["model", "text"],
      ["usd", "num"],
      ["calls", "int"],
      ["tokens_in", "int"],
      ["tokens_cached", "int"],
      ["tokens_out", "int"],
    ],
  },
  {
    name: "qr_prompts",
    pk: ["key"],
    columns: [
      ["key", "text"],
      ["body", "text"],
      ["updated_at", "int"],
    ],
  },
  {
    name: "qr_prompt_versions",
    pk: ["hash"],
    columns: [
      ["hash", "text"],
      ["key", "text"],
      ["body", "text"],
      ["first_seen", "int"],
      ["last_seen", "int"],
    ],
  },
  {
    name: "qr_inner",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["feel", "text"],
      ["want", "text"],
      ["desire", "text"],
      ["read_her", "text"],
      ["choice", "text"],
      ["now_text", "text"],
      ["longing", "text"],
      ["plans", "json"],
      ["turn_seq", "int"],
      ["updated_at", "int"],
      ["longing_updated_at", "int"],
      ["glow", "real"],
      ["glow_at", "int"],
      ["longings", "json"],
    ],
  },
  {
    name: "qr_inner_log",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["turn_seq", "int"],
      ["created_at", "int"],
      ["data", "json"],
      ["model", "text"],
      ["ms", "int"],
    ],
  },
  {
    name: "qr_dossier",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["body", "text"],
      ["cursor_at", "int"],
      ["turns_since_edit", "int"],
      ["updated_at", "int"],
      ["version", "int"],
      ["active", "bool"],
    ],
  },
  {
    name: "qr_dossier_versions",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["version", "int"],
      ["body", "text"],
      ["author", "text"],
      ["ops", "json"],
      ["created_at", "int"],
    ],
  },
  {
    name: "qr_busy_periods",
    pk: ["id"],
    columns: [
      ["id", "text"],
      ["from_day", "text"],
      ["to_day", "text"],
      ["busy", "real"],
      ["label", "text"],
      ["reason", "text"],
      ["identity_hash", "text"],
      ["created_at", "int"],
    ],
  },
  {
    name: "qr_glow_events",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["at", "int"],
      ["delta", "real"],
      ["why", "text"],
      ["source", "text"],
      ["turn_seq", "int"],
      ["glow_after", "real"],
    ],
  },
  {
    name: "qr_reach",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["next_at", "int"],
      ["intent", "text"],
      ["set_by", "text"],
      ["set_at", "int"],
      ["enabled", "bool"],
      ["retry", "int"],
    ],
  },
  {
    name: "qr_reach_log",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["at", "int"],
      ["trigger", "text"],
      ["intent", "text"],
      ["called_llm", "bool"],
      ["sent", "bool"],
      ["message_id", "text"],
      ["text", "text"],
      ["push_result", "text"],
      ["next_at", "int"],
      ["next_intent", "text"],
      ["model", "text"],
      ["ms", "int"],
    ],
  },
  {
    name: "qr_push_devices",
    pk: ["token"],
    columns: [
      ["token", "text"],
      ["env", "text"],
      ["created_at", "int"],
      ["last_ok_at", "int"],
      ["last_error", "text"],
    ],
  },
  {
    name: "qr_manual_edits",
    pk: ["id"],
    columns: [
      ["id", "int"],
      ["at", "int"],
      ["target", "text"],
      ["before", "json"],
      ["after", "json"],
    ],
  },
];

const TABLE_BY_NAME = new Map(BACKUP_TABLES.map((t) => [t.name, t]));

const computedImportOrder = [
  "brain_meta",
  "qingran_messages",
  "mem_notes",
  ...BACKUP_TABLES.map((t) => t.name).filter(
    (n) => n !== "brain_meta" && n !== "qingran_messages" && n !== "mem_notes",
  ),
];
if (computedImportOrder.join("\n") !== IMPORT_ORDER.join("\n")) {
  throw new Error("backup import order drifted from backup-public.ts");
}

function jsonSafe(value: unknown): Json {
  if (value == null) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return String(value);
}

function pkTuple(row: Record<string, unknown>, pk: string[]): string[] {
  return pk.map((k) => String(row[k] ?? ""));
}

function cmpTuple(a: string[], b: string[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

async function loadProfile(): Promise<Profile> {
  const db = await getSql();
  const rows = await db.query<{ data: unknown; identity: string | null; rhythm: string | null }>(
    "select data, identity, rhythm from qingran_profile where id = 1",
  );
  const raw = rows[0]?.data;
  const data = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  const profile = lockedProfile(data ?? {});
  const identity = String(rows[0]?.identity ?? "").trim();
  const rhythm = String(rows[0]?.rhythm ?? "").trim();
  if (identity) profile.identity = identity.slice(0, 2000);
  if (rhythm) profile.rhythm = rhythm.slice(0, 500);
  return profile;
}

async function saveProfile(profile: Profile): Promise<void> {
  const db = await getSql();
  const locked = lockedProfile(profile);
  const prev = await db.query<{ identity: string | null }>("select identity from qingran_profile where id = 1");
  const changed = String(prev[0]?.identity ?? "").trim() !== locked.identity.trim();
  await db.query(
    `insert into qingran_profile (id, data, identity, rhythm, identity_updated_at, updated_at)
     values (1, $1::jsonb, $2, $3, $4, now())
     on conflict (id) do update set
       data = excluded.data,
       identity = excluded.identity,
       rhythm = excluded.rhythm,
       identity_updated_at = case when $5 then $4 else qingran_profile.identity_updated_at end,
       updated_at = now()`,
    [JSON.stringify(locked), locked.identity, locked.rhythm, changed ? now() : 0, changed],
  );
}

export type ExportPage = {
  kind: typeof BACKUP_KIND;
  version: 2;
  exportedAt: number;
  profile?: Profile;
  table: string;
  rows: BackupRow[];
  next: BackupCursor | null;
  done: boolean;
};

export async function exportBackupPage(opts: {
  cursor?: BackupCursor | null;
  maxBytes?: number;
  exportedAt?: number;
}): Promise<ExportPage> {
  const maxBytes = opts.maxBytes ?? PAGE_BYTES;
  const exportedAt = opts.exportedAt ?? now();
  const first = !opts.cursor;
  const startIdx = opts.cursor
    ? BACKUP_TABLES.findIndex((t) => t.name === opts.cursor!.table)
    : 0;
  if (startIdx < 0) {
    return {
      kind: BACKUP_KIND,
      version: 2,
      exportedAt,
      table: "",
      rows: [],
      next: null,
      done: true,
    };
  }

  const db = await getSql();
  for (let i = startIdx; i < BACKUP_TABLES.length; i++) {
    const spec = BACKUP_TABLES[i]!;
    const after = opts.cursor && spec.name === opts.cursor.table ? opts.cursor.after : [];
    const order = spec.pk.join(", ");
    let sqlText = `select * from ${spec.name} order by ${order} limit 400`;
    const params: unknown[] = [];
    if (after.length === spec.pk.length) {
      const placeholders = spec.pk.map((_, idx) => `$${idx + 1}`);
      sqlText = `select * from ${spec.name} where (${order}) > (${placeholders.join(",")}) order by ${order} limit 400`;
      params.push(...after);
    }
    const fetched = await db.query<Record<string, unknown>>(sqlText, params);
    const rows: BackupRow[] = [];
    let encoded = 2;
    for (const row of fetched) {
      const clean: BackupRow = {};
      for (const [col] of spec.columns) {
        if (col in row) clean[col] = jsonSafe(row[col]);
      }
      const nextEncoded = encoded + JSON.stringify(clean).length + 1;
      if (rows.length && nextEncoded > maxBytes) {
        return {
          kind: BACKUP_KIND,
          version: 2,
          exportedAt,
          ...(first ? { profile: await loadProfile() } : {}),
          table: spec.name,
          rows,
          next: { table: spec.name, after: pkTuple(rows[rows.length - 1]!, spec.pk) },
          done: false,
        };
      }
      rows.push(clean);
      encoded = nextEncoded;
    }
    if (rows.length) {
      const last = rows[rows.length - 1]!;
      const more = fetched.length >= 400;
      const next: BackupCursor | null = more
        ? { table: spec.name, after: pkTuple(last, spec.pk) }
        : i + 1 < BACKUP_TABLES.length
          ? { table: BACKUP_TABLES[i + 1]!.name, after: [] }
          : null;
      return {
        kind: BACKUP_KIND,
        version: 2,
        exportedAt,
        ...(first ? { profile: await loadProfile() } : {}),
        table: spec.name,
        rows,
        next,
        done: next == null,
      };
    }
  }
  return {
    kind: BACKUP_KIND,
    version: 2,
    exportedAt,
    ...(first ? { profile: await loadProfile() } : {}),
    table: "",
    rows: [],
    next: null,
    done: true,
  };
}

function requiredOk(spec: TableSpec, row: BackupRow): boolean {
  for (const key of spec.pk) {
    if (row[key] == null || row[key] === "") return false;
  }
  return true;
}

function bindValue(kind: ColKind, value: unknown): unknown {
  if (value == null) return null;
  if (kind === "text[]" || kind === "real[]") {
    const arr = Array.isArray(value) ? value.map(String) : [];
    return pgTextArray(arr);
  }
  if (kind === "json") {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (kind === "bool") return value === true || value === "t" || value === "true" || value === 1;
  if (kind === "int" || kind === "num" || kind === "real") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return String(value);
}

export async function importTableChunk(
  table: string,
  rows: BackupRow[],
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const spec = TABLE_BY_NAME.get(table);
  if (!spec) return { inserted: 0, updated: 0, skipped: rows.length };
  if (table === "qr_push_devices") return { inserted: 0, updated: 0, skipped: rows.length };
  const db = await getSql();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const pkList = spec.pk;
  const cols = spec.columns.filter(([name]) => {
    // older dumps may omit later columns (batch_key, tier)
    return true;
  });

  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || !requiredOk(spec, raw)) {
      skipped += 1;
      continue;
    }
    const present = cols.filter(([name]) => name in raw || pkList.includes(name));
    const names = present.map(([n]) => n);
    const placeholders = present.map(([n, kind], i) => {
      if (kind === "json") return `$${i + 1}::jsonb`;
      if (kind === "text[]") return `$${i + 1}::text[]`;
      return `$${i + 1}`;
    });
    const values = present.map(([n, kind]) => bindValue(kind, raw[n]));
    const conflict = pkList.join(", ");
    const updates = names
      .filter((n) => !pkList.includes(n))
      .map((n) => `${n} = excluded.${n}`)
      .join(", ");
    const wherePk = pkList.map((n, i) => `${n} = $${i + 1}`).join(" and ");
    const pkVals = pkList.map((n) => raw[n]);
    const existing = await db.query<{ n: number }>(
      `select 1 as n from ${spec.name} where ${wherePk} limit 1`,
      pkVals,
    );
    const sqlText = updates
      ? `insert into ${spec.name} (${names.join(",")}) values (${placeholders.join(",")})
         on conflict (${conflict}) do update set ${updates}`
      : `insert into ${spec.name} (${names.join(",")}) values (${placeholders.join(",")})
         on conflict (${conflict}) do nothing`;
    await db.query(sqlText, values);
    if (existing.length) updated += 1;
    else inserted += 1;
  }
  return { inserted, updated, skipped };
}

export async function finishImport(opts: { v1?: boolean } = {}): Promise<void> {
  try {
    const db = await getSql();
    await db.query(
      `select setval('mem_history_id_seq', (select coalesce(max(id), 1) from mem_history))`,
    );
  } catch {
    /* PGLite may not expose the sequence the same way */
  }
  await bumpNotesVersion();
  resetRetrieveCache();
  const ts = now();
  if (opts.v1) {
    await enqueue("archive", `archive:import:${ts}`, { ids: [] }, ts, true);
  }
}

export type V1Backup = {
  kind: typeof BACKUP_KIND;
  version: 1;
  exportedAt?: number;
  profile?: unknown;
  memories?: Array<{ id?: string; text?: string; createdAt?: number; updatedAt?: number }>;
  messages?: Array<{
    id?: string;
    role?: string;
    text?: string;
    createdAt?: number;
    kind?: string;
  }>;
};

export function convertV1(
  raw: V1Backup,
  tz = "UTC",
): {
  profile: Profile;
  tables: {
    qingran_messages: BackupRow[];
    mem_notes: BackupRow[];
  };
} {
  const profile = lockedProfile(raw.profile ?? {});
  const messages = [...(raw.messages ?? [])]
    .map((m) => ({
      id: String(m.id ?? ""),
      role: m.role === "assistant" ? "assistant" : "user",
      body: String(m.text ?? ""),
      created_at: Number(m.createdAt) || 0,
      kind: m.kind === "steer" || m.kind === "setting" ? m.kind : "say",
    }))
    .filter((m) => m.id)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));

  let prev: { createdAt: number; sessionId: string } | null = null;
  const qingran_messages = messages.map((m) => {
    const session_id = sessionIdFor(m.created_at, prev, tz);
    prev = { createdAt: m.created_at, sessionId: session_id };
    return {
      ...m,
      archived_at: null,
      forgotten_at: null,
      session_id,
      local_day: localDay(m.created_at, tz),
    };
  });

  const mem_notes = (raw.memories ?? [])
    .filter((m) => m && (m.id || m.text))
    .map((m) => {
      const created = Number(m.createdAt) || 0;
      const id = String(m.id ?? "");
      return {
        id: id.startsWith("legacy:") ? id : `legacy:${id}`,
        text: String(m.text ?? "").slice(0, 240),
        tags: [],
        aliases: [],
        subject: "us",
        lens: ["bond", "diary"],
        from_rosie: true,
        weight: 4,
        status: "active",
        superseded_by: null,
        links: [],
        happened_at: created,
        local_day: localDay(created, tz),
        source_ids: [],
        recall_count: 0,
        last_recalled_at: null,
        created_at: created,
        updated_at: Number(m.updatedAt) || created,
      };
    });

  return { profile, tables: { qingran_messages, mem_notes } };
}

export { saveProfile, loadProfile };

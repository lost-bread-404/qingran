import { now } from "./clock.ts";
import { sql } from "./store.ts";
import type { JsonValue } from "./turn-trace.ts";

/**
 * 他记得的: one document with a size cap (docs/brain.md). The night pass rewrites it whole;
 * she can edit it or roll it back in 他的心. Every change keeps a version.
 */
export type DossierRow = {
  body: string;
  cursorAt: number;
  turnsSinceEdit: number;
  updatedAt: number;
  version: number;
  active: boolean;
};

export type DossierVersion = {
  id: number;
  version: number;
  body: string;
  author: string;
  ops: JsonValue | null;
  createdAt: number;
};

function asJson(value: unknown): JsonValue | null {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

function isOn(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function rowOf(raw: Record<string, unknown> | undefined): DossierRow {
  return {
    body: String(raw?.body ?? ""),
    cursorAt: Number(raw?.cursor_at ?? 0) || 0,
    turnsSinceEdit: Number(raw?.turns_since_edit ?? 0) || 0,
    updatedAt: Number(raw?.updated_at ?? 0) || 0,
    version: Number(raw?.version ?? 0) || 0,
    active: isOn(raw?.active),
  };
}

export async function getDossier(): Promise<DossierRow> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>("select * from qr_dossier where id = 1");
  return rowOf(rows[0]);
}

/** What the reply, the mind and the night pass see. */
export async function dossierTextForModel(): Promise<string> {
  return (await getDossier()).body.trim();
}

export async function listDossierVersions(limit = 40): Promise<DossierVersion[]> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, version, body, author, ops, created_at
     from qr_dossier_versions order by id desc limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    version: Number(row.version),
    body: String(row.body ?? ""),
    author: String(row.author ?? ""),
    ops: asJson(row.ops),
    createdAt: Number(row.created_at ?? 0),
  }));
}

async function writeVersion(input: {
  version: number;
  body: string;
  author: string;
  ops: unknown;
  at: number;
}): Promise<void> {
  const db = await sql();
  await db.query(
    `insert into qr_dossier_versions (version, body, author, ops, created_at) values ($1,$2,$3,$4::jsonb,$5)`,
    [input.version, input.body, input.author, input.ops == null ? null : JSON.stringify(input.ops), input.at],
  );
}

export async function saveDossierBody(body: string, author: "rosie"): Promise<DossierRow> {
  const db = await sql();
  const at = now();
  const current = await getDossier();
  const version = current.version + 1;
  await db.query(
    `update qr_dossier set body = $1, version = $2, updated_at = $3 where id = 1`,
    [body, version, at],
  );
  await writeVersion({ version, body, author, ops: null, at });
  return getDossier();
}

/** The night pass (or an import) rewrites the whole document; it goes live at once and the cursor moves to `cursorAt`. */
export async function publishMemory(body: string, author: "night" | "import", cursorAt: number, ops: unknown = null): Promise<DossierRow> {
  const db = await sql();
  const at = now();
  const current = await getDossier();
  const version = current.version + 1;
  const text = body.trim() ? `${body.trim()}\n` : "";
  await db.query(
    `update qr_dossier
     set body = $1, version = $2, updated_at = $3, active = true, cursor_at = greatest(cursor_at, $4), turns_since_edit = 0
     where id = 1`,
    [text, version, at, Math.round(cursorAt)],
  );
  await writeVersion({ version, body: text, author, ops, at });
  return getDossier();
}

export async function rollbackDossier(versionId: number): Promise<DossierRow> {
  const db = await sql();
  const rows = await db.query<Record<string, unknown>>(
    "select body from qr_dossier_versions where id = $1",
    [versionId],
  );
  const body = rows[0] ? String(rows[0].body ?? "") : null;
  if (body == null) throw new Error("找不到这个版本");
  return saveDossierBody(body, "rosie");
}

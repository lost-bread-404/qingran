import { getSql } from "../db.ts";
import { lockedProfile, type Profile } from "./types.ts";

export const VERSIONED_FIELDS = ["systemPrompt", "intimateNotes", "identity"] as const;
export type VersionedField = (typeof VERSIONED_FIELDS)[number];

export type FieldRevs = Record<VersionedField, number>;

export type ProfilePatchResult =
  | { ok: true; profile: Profile; revs: FieldRevs; updatedAt: number }
  | {
      ok: false;
      conflict: true;
      field: VersionedField;
      latest: string;
      profile: Profile;
      revs: FieldRevs;
      updatedAt: number;
    };

type Snapshot = {
  exists: boolean;
  profile: Profile;
  revs: FieldRevs;
  updatedAt: number;
};

const PATCH_KEYS = [
  "systemPrompt",
  "muted",
  "voiceSpeed",
  "autoRemember",
  "memoryCursor",
  "hearingProvider",
  "captureAudio",
  "debugHearing",
  "hearingNbest",
  "voiceModel",
  "voiceEffort",
  "silenceMs",
  "injectMind",
  "injectMemories",
  "injectLongterm",
  "historyWindow",
  "nightMode",
  "nightVoicedMin",
  "nightMinMs",
  "hearingSense",
  "promptModels",
  "hearingInstruction",
  "sttKeyterms",
  "portraitActiveMax",
  "portraitStaleDays",
  "retrieveMinTerms",
  "callKitBackground",
  "dossierMaxChars",
  "identity",
  "rhythm",
  "glowHalfLifeDays",
  "diaryEnabled",
  "intimateNotes",
  "storyline",
  "brainOn",
  "mode",
  "routine",
  "realModel",
  "realEffort",
  "realPrompt",
  "personaPlacement",
] as const satisfies readonly (keyof Profile)[];

const PATCH_KEY_SET = new Set<string>(PATCH_KEYS);

export function emptyFieldRevs(): FieldRevs {
  return { systemPrompt: 0, intimateNotes: 0, identity: 0 };
}

export function readFieldRevs(raw: unknown): FieldRevs {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const n = (value: unknown) => {
    const x = Number(value);
    return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
  };
  return {
    systemPrompt: n(obj.systemPrompt),
    intimateNotes: n(obj.intimateNotes),
    identity: n(obj.identity),
  };
}

function isVersioned(field: string): field is VersionedField {
  return field === "systemPrompt" || field === "intimateNotes" || field === "identity";
}

function msOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

type ProfileRow = {
  data: unknown;
  identity: string | null;
  rhythm: string | null;
  field_revs: unknown;
  updated_at: unknown;
};

function snapshotFrom(row: ProfileRow | undefined): Snapshot {
  if (!row) {
    return { exists: false, profile: lockedProfile({}), revs: emptyFieldRevs(), updatedAt: 0 };
  }
  const raw = typeof row.data === "string" ? safeJson(row.data) : row.data;
  const profile = lockedProfile(raw ?? {});
  if (typeof row.identity === "string" && row.identity.trim()) {
    profile.identity = row.identity.trim().slice(0, 2000);
  }
  if (typeof row.rhythm === "string" && row.rhythm.trim()) {
    profile.rhythm = row.rhythm.trim().slice(0, 500);
  }
  return {
    exists: true,
    profile,
    revs: readFieldRevs(row.field_revs),
    updatedAt: msOf(row.updated_at),
  };
}

const ROW_SQL = `select data, identity, rhythm, field_revs, updated_at from qingran_profile where id = 1`;

export async function readProfileSnapshot(): Promise<Snapshot> {
  const db = await getSql();
  const rows = await db.query<ProfileRow>(ROW_SQL);
  return snapshotFrom(rows[0]);
}

function clampPatch(patch: Partial<Profile>): Partial<Profile> {
  const locked = lockedProfile(patch);
  const out: Partial<Profile> = {};
  for (const key of PATCH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    (out as Record<string, unknown>)[key] = locked[key];
  }
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEY_SET.has(key)) delete (out as Record<string, unknown>)[key];
  }
  return out;
}

function conflict(field: VersionedField, snap: Snapshot): ProfilePatchResult {
  return {
    ok: false,
    conflict: true,
    field,
    latest: snap.profile[field],
    profile: snap.profile,
    revs: snap.revs,
    updatedAt: snap.updatedAt,
  };
}

function okResult(snap: Snapshot): ProfilePatchResult {
  return { ok: true, profile: snap.profile, revs: snap.revs, updatedAt: snap.updatedAt };
}

async function insertVersion(field: VersionedField, value: string, source: string, at: number): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into qr_profile_versions (field, value, source, at) values ($1, $2, $3, $4)`,
    [field, value, source.slice(0, 300), at],
  );
}

export async function applyProfilePatch(input: {
  patch: Partial<Profile>;
  baseRevs?: Partial<FieldRevs>;
  source?: string;
  force?: boolean;
  at?: number;
}): Promise<ProfilePatchResult> {
  const source = (input.source || "web").slice(0, 300);
  const at = input.at ?? Date.now();
  const clamped = clampPatch(input.patch ?? {});
  const before = await readProfileSnapshot();

  for (const field of VERSIONED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(clamped, field)) continue;
    const expected = input.force ? before.revs[field] : Number(input.baseRevs?.[field]);
    const revOk = input.force || (Number.isFinite(expected) && expected === before.revs[field]);
    if (!revOk) {
      if (before.profile[field] === clamped[field]) {
        delete clamped[field];
        continue;
      }
      return conflict(field, before);
    }
    if (before.profile[field] === clamped[field]) delete clamped[field];
  }

  if (!Object.keys(clamped).length) return okResult(before);

  const revPatch: Partial<FieldRevs> = {};
  const versionedWrites: VersionedField[] = [];
  for (const field of VERSIONED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(clamped, field)) continue;
    revPatch[field] = before.revs[field] + 1;
    versionedWrites.push(field);
  }

  const hasIdentity = Object.prototype.hasOwnProperty.call(clamped, "identity");
  const hasRhythm = Object.prototype.hasOwnProperty.call(clamped, "rhythm");
  const identity = hasIdentity ? String(clamped.identity ?? "") : "";
  const rhythm = hasRhythm ? String(clamped.rhythm ?? "") : "";
  const check = (field: VersionedField) => !Object.prototype.hasOwnProperty.call(clamped, field) || Boolean(input.force);
  const expected = (field: VersionedField) => (input.force ? before.revs[field] : Number(input.baseRevs?.[field]) || 0);

  const db = await getSql();
  const params = [
    JSON.stringify(clamped),
    hasIdentity,
    identity,
    at,
    hasRhythm,
    rhythm,
    JSON.stringify(revPatch),
    check("systemPrompt"),
    expected("systemPrompt"),
    check("intimateNotes"),
    expected("intimateNotes"),
    check("identity"),
    expected("identity"),
  ];
  const writeSql = `update qingran_profile set
       data = coalesce(qingran_profile.data, '{}'::jsonb) || $1::jsonb,
       identity = case when $2::boolean then $3 else qingran_profile.identity end,
       identity_updated_at = case
         when $2::boolean and qingran_profile.identity is distinct from $3 then $4
         else qingran_profile.identity_updated_at end,
       rhythm = case when $5::boolean then $6 else qingran_profile.rhythm end,
       field_revs = coalesce(qingran_profile.field_revs, '{}'::jsonb) || $7::jsonb,
       updated_at = now()
     where id = 1
       and ($8::boolean or coalesce((qingran_profile.field_revs->>'systemPrompt')::bigint, 0) = $9::bigint)
       and ($10::boolean or coalesce((qingran_profile.field_revs->>'intimateNotes')::bigint, 0) = $11::bigint)
       and ($12::boolean or coalesce((qingran_profile.field_revs->>'identity')::bigint, 0) = $13::bigint)
     returning data, identity, rhythm, field_revs, updated_at`;

  let rows = before.exists ? await db.query<ProfileRow>(writeSql, params) : [];
  if (!rows[0] && !before.exists) {
    await db.query(
      `insert into qingran_profile (id, data, identity, rhythm, identity_updated_at, field_revs, updated_at)
       values (1, $1::jsonb, $2, $3, $4, $5::jsonb, now())
       on conflict (id) do update set
         data = coalesce(qingran_profile.data, '{}'::jsonb) || excluded.data,
         identity = case when $6::boolean then excluded.identity else qingran_profile.identity end,
         rhythm = case when $7::boolean then excluded.rhythm else qingran_profile.rhythm end,
         identity_updated_at = case
           when $6::boolean and qingran_profile.identity is distinct from excluded.identity then excluded.identity_updated_at
           else qingran_profile.identity_updated_at end,
         field_revs = coalesce(qingran_profile.field_revs, '{}'::jsonb) || excluded.field_revs,
         updated_at = now()`,
      [JSON.stringify(clamped), identity, rhythm, hasIdentity ? at : 0, JSON.stringify(revPatch), hasIdentity, hasRhythm],
    );
    rows = await db.query<ProfileRow>(ROW_SQL);
  }
  if (!rows[0]) {
    const raced = await readProfileSnapshot();
    const field = versionedWrites.find((name) => raced.revs[name] !== before.revs[name]) ?? versionedWrites[0];
    if (field) return conflict(field, raced);
    return okResult(raced);
  }

  for (const field of versionedWrites) {
    await insertVersion(field, String(clamped[field] ?? ""), source, at);
  }
  return okResult(snapshotFrom(rows[0]));
}

export async function writeProfileDocument(profile: Profile, source = "backup"): Promise<void> {
  const locked = lockedProfile(profile);
  const before = await readProfileSnapshot();
  const at = Date.now();
  const revs = { ...before.revs };
  const changed: VersionedField[] = [];
  for (const field of VERSIONED_FIELDS) {
    if (before.profile[field] === locked[field]) continue;
    revs[field] = before.revs[field] + 1;
    changed.push(field);
  }
  const identChanged = before.profile.identity !== locked.identity;
  const db = await getSql();
  await db.query(
    `insert into qingran_profile (id, data, identity, rhythm, identity_updated_at, field_revs, updated_at)
     values (1, $1::jsonb, $2, $3, $4, $5::jsonb, now())
     on conflict (id) do update set
       data = excluded.data,
       identity = excluded.identity,
       rhythm = excluded.rhythm,
       identity_updated_at = case when $6::boolean then excluded.identity_updated_at else qingran_profile.identity_updated_at end,
       field_revs = excluded.field_revs,
       updated_at = now()`,
    [JSON.stringify(locked), locked.identity, locked.rhythm, identChanged ? at : 0, JSON.stringify(revs), identChanged],
  );
  for (const field of changed) {
    await insertVersion(field, locked[field], source, at);
  }
}

export async function listProfileVersions(
  field: string,
  limit = 40,
): Promise<Array<{ id: number; field: VersionedField; value: string; source: string; at: number }>> {
  if (!isVersioned(field)) return [];
  const db = await getSql();
  const rows = await db.query<{ id: number; field: string; value: string; source: string; at: number }>(
    `select id, field, value, source, at from qr_profile_versions
     where field = $1 order by at desc, id desc limit $2`,
    [field, Math.max(1, Math.min(80, limit))],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    field,
    value: String(row.value ?? ""),
    source: String(row.source ?? ""),
    at: Number(row.at) || 0,
  }));
}

export async function restoreProfileVersion(id: number, source = "history"): Promise<ProfilePatchResult | null> {
  const db = await getSql();
  const rows = await db.query<{ field: string; value: string }>(
    `select field, value from qr_profile_versions where id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row || !isVersioned(String(row.field))) return null;
  return applyProfilePatch({
    patch: { [row.field]: String(row.value ?? "") },
    force: true,
    source,
  });
}

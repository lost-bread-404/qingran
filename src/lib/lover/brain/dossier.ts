import { clampDossierMaxChars, DOSSIER_MAX_CHARS, SESSION_GAP_MS } from "./config.ts";
import { now } from "./clock.ts";
import { callModel, type CallModelResult } from "./llm.ts";
import { enqueue } from "./jobs.ts";
import { isNightNoiseBody, modelFacingText } from "../message-markup.ts";
import {
  getInner,
  getMeta,
  getProfileData,
  getProfilePrompt,
  listPortrait,
  sql,
} from "./store.ts";
import { formatClock, localDay, shiftDay } from "./time.ts";
import { resolveTz } from "./tz.ts";
import { lockedProfile } from "../types.ts";
import { parsePromptBody, renderVariant } from "./prompts/doc.ts";
import { loadPrompt } from "./prompts/store.ts";
import { dossierSections } from "./voice/pack-build.ts";
import { identityBlock } from "./life.ts";
import { readIdentity } from "./life-store.ts";
import type { JsonValue } from "./turn-trace.ts";
import {
  applyDossierOps,
  batchConversation,
  DEFAULT_DOSSIER,
  editorDue,
  type ConvoItem,
} from "./dossier-text.ts";

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

type Completer = typeof callModel;

const OPS_SCHEMA = {
  name: "dossier_ops",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ops"],
    properties: {
      ops: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["section", "action", "old", "new"],
          properties: {
            section: { type: "string" },
            action: { type: "string", enum: ["add", "replace", "remove"] },
            old: { type: "string" },
            new: { type: "string" },
          },
        },
      },
    },
  },
};

const BODY_SCHEMA = {
  name: "dossier_body",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["body"],
    properties: { body: { type: "string" } },
  },
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

/** What the reply and reflect prompts should see. Old longterm until Rosie enables this. */
export async function dossierTextForModel(): Promise<string> {
  const row = await getDossier();
  if (row.active) return row.body.trim();
  const [meta, portrait] = await Promise.all([getMeta(), listPortrait()]);
  return dossierSections(meta.selfSummary, meta.bondSummary, portrait);
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

export async function saveDossierBody(body: string, author: "rosie" | "seed" | "editor" | "compact"): Promise<DossierRow> {
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

export async function enableDossier(body: string): Promise<DossierRow> {
  const db = await sql();
  const at = now();
  const current = await getDossier();
  const version = current.version + 1;
  const latest = await db.query<{ at: number | null }>(
    "select max(created_at)::float8 as at from qingran_messages",
  );
  const cursor = Number(latest[0]?.at ?? 0) || 0;
  await db.query(
    `update qr_dossier
     set body = $1, version = $2, updated_at = $3, active = true, cursor_at = $4, turns_since_edit = 0
     where id = 1`,
    [body, version, at, cursor],
  );
  await writeVersion({ version, body, author: "rosie", ops: { enable: true }, at });
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

async function maxChars(): Promise<number> {
  const profile = lockedProfile(await getProfileData());
  return clampDossierMaxChars(profile.dossierMaxChars, DOSSIER_MAX_CHARS);
}

async function listAfterCursor(cursorAt: number): Promise<Array<Record<string, unknown>>> {
  const db = await sql();
  return db.query<Record<string, unknown>>(
    `select id, role, body, created_at
     from qingran_messages
     where created_at > $1 and forgotten_at is null and kind is distinct from 'system_notice'
     order by created_at asc, id asc`,
    [cursorAt],
  );
}

function convoItems(rows: Array<Record<string, unknown>>, timeZone: string): ConvoItem[] {
  const items: ConvoItem[] = [];
  for (const row of rows) {
    const text = modelFacingText(String(row.body ?? ""));
    if (!text.trim() || isNightNoiseBody(String(row.body ?? ""))) continue;
    const who = row.role === "user" ? "Rosie" : "清然";
    const createdAt = Number(row.created_at) || 0;
    items.push({
      createdAt,
      line: `[${formatClock(createdAt, timeZone)}] ${who}：${text}`,
    });
  }
  return items;
}

async function commitBody(input: {
  body: string;
  cursorAt: number;
  author: string;
  ops: unknown;
  resetTurns: boolean;
}): Promise<void> {
  const db = await sql();
  const at = now();
  const current = await getDossier();
  const version = current.version + 1;
  await db.query(
    `update qr_dossier
     set body = $1, version = $2, updated_at = $3, cursor_at = $4,
         turns_since_edit = case when $5::boolean then 0 else turns_since_edit end
     where id = 1`,
    [input.body, version, at, input.cursorAt, input.resetTurns],
  );
  await writeVersion({ version, body: input.body, author: input.author, ops: input.ops, at });
}

async function identityLine(): Promise<string> {
  const block = identityBlock((await readIdentity()).identity);
  return block ? `${block}\n` : "";
}

function packed(variant: "main" | "compact" | "seed", vars: Record<string, string>, template: string) {
  const messages = renderVariant(parsePromptBody("editor", template), variant, vars);
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const user = messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n\n");
  return { system, user };
}

async function requireJson(result: CallModelResult, label: string): Promise<Record<string, unknown>> {
  if (!result.ok || !result.json || typeof result.json !== "object") {
    throw new Error(`${label}:${result.failKind || "bad json"}`);
  }
  return result.json as Record<string, unknown>;
}

export async function runEditor(reason = "turns", complete: Completer = callModel): Promise<{ batches: number }> {
  const row = await getDossier();
  const meta = await getMeta();
  const tz = resolveTz(meta.timeZone);
  const unread = await listAfterCursor(row.cursorAt);
  const items = convoItems(unread, tz);
  if (!items.length) {
    const db = await sql();
    await db.query("update qr_dossier set turns_since_edit = 0 where id = 1");
    return { batches: 0 };
  }
  const loaded = await loadPrompt("editor");
  const longing = (await getInner()).longing.trim() || "（没有）";
  const systemPrompt = await getProfilePrompt();
  const limit = await maxChars();
  const identity_block = await identityLine();
  let body = row.body.trim() ? row.body : DEFAULT_DOSSIER;
  let cursor = row.cursorAt;
  const batches = batchConversation(items);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i]!;
    const conversation = batch.map((item) => item.line).join("\n");
    const prompt = packed("main", {
      identity_block,
      system_prompt: systemPrompt,
      dossier: body,
      longing,
      conversation,
      max_chars: String(limit),
    }, loaded.body);
    const result = await complete("editor", {
      system: prompt.system,
      input: prompt.user,
      schema: OPS_SCHEMA,
      promptKey: loaded.key,
      promptHash: loaded.hash,
      outputRef: `dossier:${reason}`,
    });
    const json = await requireJson(result, "editor");
    const applied = applyDossierOps(body, json.ops);
    body = applied.body;
    cursor = batch[batch.length - 1]!.createdAt;
    const last = i === batches.length - 1;
    await commitBody({
      body,
      cursorAt: cursor,
      author: "editor",
      ops: { ops: applied.ops, skipped: applied.skipped, reason },
      resetTurns: last,
    });
  }
  if (body.trim().length > limit) {
    const prompt = packed("compact", { identity_block, dossier: body, max_chars: String(limit) }, loaded.body);
    const result = await complete("editor", {
      system: prompt.system,
      input: prompt.user,
      schema: BODY_SCHEMA,
      promptKey: loaded.key,
      promptHash: loaded.hash,
      outputRef: "dossier:compact",
    });
    const json = await requireJson(result, "compact");
    const compactBody = typeof json.body === "string" ? json.body.trim() : "";
    if (compactBody) {
      const clipped = compactBody.length > limit ? `${compactBody.slice(0, limit)}` : compactBody;
      await commitBody({
        body: clipped.endsWith("\n") ? clipped : `${clipped}\n`,
        cursorAt: cursor,
        author: "compact",
        ops: { max_chars: limit },
        resetTurns: true,
      });
    }
  }
  return { batches: batches.length };
}

export async function seedDossierDraft(complete: Completer = callModel): Promise<DossierVersion> {
  const loaded = await loadPrompt("editor");
  const [systemPrompt, meta, portrait, inner] = await Promise.all([
    getProfilePrompt(),
    getMeta(),
    listPortrait(),
    getInner(),
  ]);
  const tz = resolveTz(meta.timeZone);
  const today = localDay(now(), tz);
  const fromDay = shiftDay(today, -60);
  const db = await sql();
  const notes = await db.query<Record<string, unknown>>(
    `select local_day, subject, weight, text from mem_notes
     where status = 'active' and weight >= 3 and local_day >= $1
     order by local_day desc, weight desc
     limit 150`,
    [fromDay],
  );
  const story = (await import("./story.ts")).loadStorySeed();
  const storyText = [
    ...story.portrait.map((row) => `画像 ${row.topic}：${row.body}`),
    ...story.notes.map((row) => `${row.local_day} ${row.subject}：${row.text}`),
  ].join("\n");
  const legacy = [
    meta.selfSummary.trim() ? `我自己：${meta.selfSummary.trim()}` : "",
    meta.bondSummary.trim() ? `我们：${meta.bondSummary.trim()}` : "",
    ...portrait
      .filter((row) => row.status === "active")
      .map((row) => `${row.topic}：${row.body}`),
    inner.longing.trim() ? `惦记：${inner.longing.trim()}` : "",
  ].filter(Boolean).join("\n");
  const noteText = notes.map((row) => `${row.local_day} ${row.subject} w${row.weight}：${row.text}`).join("\n");
  const limit = await maxChars();
  const identity_block = await identityLine();
  const prompt = packed("seed", {
    identity_block,
    system_prompt: systemPrompt,
    max_chars: String(limit),
    story: storyText || "（没有）",
    legacy: legacy || "（没有）",
    notes: noteText || "（没有）",
  }, loaded.body);
  const result = await complete("editor", {
    system: prompt.system,
    input: prompt.user,
    schema: BODY_SCHEMA,
    promptKey: loaded.key,
    promptHash: loaded.hash,
    outputRef: "dossier:seed",
  });
  const json = await requireJson(result, "seed");
  const body = typeof json.body === "string" ? json.body.trim() : "";
  if (!body) throw new Error("seed:empty");
  const text = body.length > limit ? body.slice(0, limit) : body;
  const stored = text.endsWith("\n") ? text : `${text}\n`;
  const at = now();
  const current = await getDossier();
  await writeVersion({ version: current.version, body: stored, author: "seed", ops: null, at });
  const versions = await listDossierVersions(1);
  const draft = versions[0];
  if (!draft) throw new Error("seed:not stored");
  return draft;
}

export async function noteRosieTurn(createdAt: number): Promise<void> {
  const db = await sql();
  const prev = await db.query<{ at: number | null }>(
    `select max(created_at)::float8 as at from qingran_messages
     where role = 'user' and created_at < $1 and forgotten_at is null`,
    [createdAt],
  );
  const previousAt = Number(prev[0]?.at ?? 0) || 0;
  const bumped = await db.query<Record<string, unknown>>(
    `update qr_dossier set turns_since_edit = turns_since_edit + 1 where id = 1
     returning turns_since_edit, cursor_at, active`,
  );
  const row = rowOf(bumped[0]);
  const unreadRows = await db.query<{ n: number }>(
    `select count(*)::int as n from qingran_messages where created_at > $1 and forgotten_at is null`,
    [row.cursorAt],
  );
  const gap = previousAt > 0 && createdAt - previousAt > SESSION_GAP_MS;
  const due = editorDue({
    active: row.active,
    turns: row.turnsSinceEdit,
    gap,
    unread: Number(unreadRows[0]?.n ?? 0) > 0,
  });
  if (!due) return;
  await enqueue("editor", due === "manual" ? `editor:manual:${createdAt}` : "editor:due", { reason: due });
}

export async function enqueueEditorNow(): Promise<void> {
  const at = now();
  await enqueue("editor", `editor:manual:${at}`, { reason: "manual" }, at, true);
}

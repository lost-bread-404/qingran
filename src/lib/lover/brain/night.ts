import { callModel, type CallModelResult } from "./llm.ts";
import { now } from "./clock.ts";
import { appendInnerLog, getMeta, getProfileData, getProfilePrompt, patchBrainLog, sql } from "./store.ts";
import { resolveTz } from "./tz.ts";
import { clockOf, localDay } from "./time.ts";
import { lockedProfile } from "../types.ts";
import { isNightNoiseBody, modelFacingText } from "../message-markup.ts";
import { parsePromptBody, renderVariant } from "./prompts/doc.ts";
import { loadPrompt } from "./prompts/store.ts";
import { dossierTextForModel, publishMemory } from "./dossier.ts";
import { identityBlock } from "./life.ts";
import { readIdentity } from "./life-store.ts";
import { enqueue } from "./jobs.ts";
import { spokenOnly } from "./voice/pack-build.ts";
import { dayClockMs, dayWindow, saveDayTimeline } from "./heart.ts";
import { addMemories, embedMissing, getMark, memoriesWithIds, recall, setMark, syncStory, updateMemory, type NewMemory } from "./memory.ts";

/**
 * The night pass (docs/brain.md v6): once for each day that has ended, fold it into his memory.
 * One call writes the day's moments (added, never rewritten), what he newly understood about Rosie, which older
 * moments are no longer so, a fresh 「清然和 Rosie 现在」 and the day's timeline (for the monthly report).
 * Days are done oldest first, one at a time, so a backlog (the days before this design, or a missed night) catches up
 * in order and each day sees the 「现在」 the day before left.
 */
const ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["time", "body", "keys", "thread", "importance"] as string[],
  properties: {
    time: { type: "string" },
    body: { type: "string" },
    keys: { type: "string" },
    thread: { type: "string" },
    importance: { type: "integer" },
  },
};

export const NIGHT_SCHEMA = {
  name: "night",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["moments", "insights", "changed", "us", "timeline", "changes"] as string[],
    properties: {
      moments: { type: "array", items: ITEM },
      insights: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["body", "keys", "importance"] as string[],
          properties: { body: { type: "string" }, keys: { type: "string" }, importance: { type: "integer" } },
        },
      },
      changed: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "note"] as string[],
          properties: { id: { type: "integer" }, note: { type: "string" } },
        },
      },
      us: { type: "string" },
      timeline: { type: "string" },
      changes: { type: "string" },
    },
  },
};

/** Cap on the day's conversation sent at night. Past this, his lines keep only what he said aloud. */
const NIGHT_CONVERSATION_MAX = 60_000;
/** How many older moments the night pass sees, to tell which of them the day changed. */
const NIGHT_RELATED = 20;

type Row = { id: string; role: string; body: string; created_at: number };

async function dayMessages(from: number, to: number): Promise<Row[]> {
  const db = await sql();
  const rows = await db.query<Row>(
    `select id, role, body, created_at::float8 as created_at from qingran_messages
     where created_at >= $1 and created_at < $2 and forgotten_at is null and kind is distinct from 'system_notice'
     order by created_at asc, id asc`,
    [from, to],
  );
  return rows.map((r) => ({ ...r, created_at: Number(r.created_at) }));
}

export function nightConversation(rows: Row[], timeZone: string): string {
  const render = (spoken: boolean) =>
    rows
      .filter((r) => !isNightNoiseBody(r.body))
      .map((r) => {
        const text = modelFacingText(r.body);
        const body = r.role === "assistant" && spoken ? spokenOnly(text) : text;
        return `[${clockOf(r.created_at, timeZone)}] ${r.role === "user" ? "Rosie" : "清然"}：${body}`;
      })
      .join("\n");
  let text = render(false);
  if (text.length > NIGHT_CONVERSATION_MAX) text = render(true);
  if (text.length > NIGHT_CONVERSATION_MAX) text = text.slice(-NIGHT_CONVERSATION_MAX);
  return text;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function runNight(day: string, jobId?: string, complete: typeof callModel = callModel): Promise<{ ok: boolean; skipped?: string }> {
  const at = now();
  const tz = resolveTz((await getMeta()).timeZone);
  const window = dayWindow(day, tz);
  const [rows, profileData, charter, us, ident] = await Promise.all([
    dayMessages(window.from, window.to),
    getProfileData(),
    getProfilePrompt(),
    dossierTextForModel(),
    readIdentity(),
  ]);
  if (!rows.length) {
    await setMark(`day:${day}`, "empty", at);
    return { ok: true, skipped: "empty" };
  }
  const profile = lockedProfile(profileData);
  await syncStory(profile.storyline);
  const conversation = nightConversation(rows, tz);
  // The older moments this day is most about: the night pass may mark some of them as no longer so.
  const herLines = rows.filter((r) => r.role === "user").map((r) => modelFacingText(r.body)).join("\n");
  const related = (await recall(herLines.slice(-6000), window.to, { top: NIGHT_RELATED, minFit: 4, keepShare: 0, withThread: 0, minCos: 0.35 })).memories;
  const loaded = await loadPrompt("editor");
  const messages = renderVariant(parsePromptBody("editor", loaded.body), "main", {
    system_prompt: charter,
    identity_block: identityBlock(ident.identity) ? `${identityBlock(ident.identity)}\n` : "",
    us: us.trim() || "（还没有）",
    memories: memoriesWithIds(related) || "（没有）",
    day,
    conversation: conversation || "（没有）",
    max_chars: String(profile.dossierMaxChars),
  });
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const users = messages.filter((m) => m.role !== "system").map((m) => m.content);
  const result: CallModelResult = await complete("editor", {
    system,
    input: users.join("\n\n"),
    inputParts: users,
    schema: NIGHT_SCHEMA,
    jobId,
    promptKey: loaded.key,
    promptHash: loaded.hash,
    outputRef: `night:${day}`,
  });
  if (!result.ok || !result.json) {
    await appendInnerLog({ turnSeq: 0, data: { kind: "night", day, error: result.failKind ?? "failed" }, model: result.model, ms: result.ms });
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
    throw new Error(`night:${result.failKind ?? "failed"}`);
  }
  const json = result.json as Record<string, unknown>;
  const fresh: NewMemory[] = [];
  for (const raw of Array.isArray(json.moments) ? json.moments : []) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const body = str(item.body);
    if (!body) continue;
    fresh.push({
      kind: "moment",
      source: "night",
      day,
      at: dayClockMs(day, str(item.time), tz) ?? window.from,
      body,
      keys: str(item.keys),
      thread: str(item.thread),
      importance: Number(item.importance),
    });
  }
  for (const raw of Array.isArray(json.insights) ? json.insights : []) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const body = str(item.body);
    if (!body) continue;
    fresh.push({ kind: "insight", source: "night", day, at: window.to - 1, body, keys: str(item.keys), importance: Number(item.importance) });
  }
  await addMemories(fresh);
  const relatedIds = new Set(related.map((m) => m.id));
  for (const raw of Array.isArray(json.changed) ? json.changed : []) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const id = Number(item.id);
    const note = str(item.note);
    if (relatedIds.has(id) && note) await updateMemory(id, { changed: note });
  }
  const nextUs = str(json.us);
  if (nextUs) await publishMemory(nextUs, "night", Math.min(window.to, at), { day, changes: str(json.changes).slice(0, 1000) });
  await saveDayTimeline(day, str(json.timeline), at);
  await setMark(`day:${day}`, "done", at);
  await embedMissing().catch(() => 0);
  await appendInnerLog({ turnSeq: 0, data: { kind: "night", day, output: result.json }, model: result.model, ms: result.ms });
  return { ok: true };
}

/** The oldest day that has ended (04:00 local) and has messages, but is not in his memory yet. */
export async function nextNightDay(at = now()): Promise<string | null> {
  const tz = resolveTz((await getMeta()).timeZone);
  const today = localDay(at, tz);
  const db = await sql();
  const rows = await db.query<{ day: string }>(
    `select distinct local_day as day from qingran_messages
     where local_day is not null and local_day < $1 and forgotten_at is null and kind is distinct from 'system_notice'
       and not exists (select 1 from qr_memory_marks m where m.key = 'day:' || qingran_messages.local_day)
     order by local_day asc limit 1`,
    [today],
  );
  const day = rows[0]?.day ? String(rows[0].day) : null;
  if (!day) return null;
  return (await getMark(`day:${day}`)) ? null : day;
}

/** Called after each reply and from the wake: the story's moments are kept in step, and one ended day gets its night pass. */
export async function enqueueMemoryWork(at = now()): Promise<string | null> {
  const profile = lockedProfile(await getProfileData());
  if (!profile.brainOn) return null;
  await syncStory(profile.storyline);
  await embedMissing().catch(() => 0);
  const day = await nextNightDay(at);
  if (!day) return null;
  await enqueue("night", `memory:${day}`, { day });
  return day;
}

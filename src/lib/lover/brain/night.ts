import { callModel, type CallModelResult } from "./llm.ts";
import { now } from "./clock.ts";
import { appendInnerLog, getMeta, getProfileData, getProfilePrompt, patchBrainLog, patchMeta, sql } from "./store.ts";
import { resolveTz } from "./tz.ts";
import { clockOf, localDay } from "./time.ts";
import { lockedProfile } from "../types.ts";
import { fromStored, modelFacingText } from "../message-meta.ts";
import { parsePromptBody, renderVariant } from "./prompts/doc.ts";
import { loadPrompt } from "./prompts/store.ts";
import { dossierTextForModel, publishMemory } from "./dossier.ts";
import { identityBlock } from "./life.ts";
import { readIdentity } from "./life-store.ts";
import { enqueue } from "./jobs.ts";
import { spokenOnly } from "./voice/pack-build.ts";
import { appendDayTimeline, dayClockMs, dayWindow, saveDayTimeline } from "./heart.ts";
import { addFeedback, addMemories, embedMissing, getMark, listMemories, memoriesWithIds, setMark, syncStory, updateMemory, type NewMemory } from "./memory.ts";

/**
 * The night pass (docs/brain.md v6): once for each day that has ended, fold it into his memory.
 * Memory is a handful of events and understandings that change how 清然 acts later — not a diary. One call:
 * - events: what happened that matters later; a topic that continues (林泽搬家, 口腔溃疡, 找实习) is merged into its
 *   existing event (the whole event rewritten, by id) instead of added again;
 * - insights: what he understood about Rosie (likes, limits, what comforts her), also updated by id;
 * - feedback: Rosie's complaints about how 清然 behaved — kept in the back (qr_feedback) to tune the app, never shown to him;
 * - a fresh 「清然和 Rosie 现在」 and the day's timeline (for the monthly report).
 * Days are done oldest first, one at a time, so a backlog catches up in order.
 */
const ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["id", "time", "body", "keys", "thread", "importance", "knows"] as string[],
  properties: {
    id: { type: "integer" },
    knows: { type: "string" },
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
    required: ["events", "insights", "feedback", "us", "timeline", "changes"] as string[],
    properties: {
      events: { type: "array", items: ITEM },
      insights: { type: "array", items: ITEM },
      feedback: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["time", "body"] as string[],
          properties: { time: { type: "string" }, body: { type: "string" } },
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
/** The night pass sees every event and understanding so far (they are few), to merge into the right one. */
const NIGHT_MEMORIES = 200;

type Row = { id: string; role: string; body: string; meta: unknown; created_at: number };

async function dayMessages(from: number, to: number): Promise<Row[]> {
  const db = await sql();
  const rows = await db.query<Row>(
    `select id, role, body, meta, created_at::float8 as created_at from qingran_messages
     where created_at >= $1 and created_at < $2 and forgotten_at is null and kind is distinct from 'system_notice'
     order by created_at asc, id asc`,
    [from, to],
  );
  return rows.map((r) => ({ ...r, created_at: Number(r.created_at) }));
}

/**
 * A reply goes in as he wrote it: other people's blocks keep their own 「林泽：」 lines and the editor (a model)
 * reads who is who, so nothing here has to guess whether 「小猫：」 is a name. Cut short, a line keeps its label.
 */
function keepLabels(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const label = line.match(/^[\s*]*[^\s：:“”「」（）()]{1,8}\**\s*[：:]/)?.[0] ?? "";
      const said = spokenOnly(line.slice(label.length));
      return label && said ? `${label.trim()}${said}` : label ? label.trim() : said;
    })
    .filter((line) => line.trim())
    .join("\n");
}

export function nightConversation(rows: Row[], timeZone: string): string {
  const render = (spoken: boolean) =>
    rows
      .map((r) => ({ ...r, ...fromStored(r.body, r.meta) }))
      .filter((r) => !r.meta.nightNoise)
      .map((r) => {
        const text = modelFacingText(r);
        const at = `[${clockOf(r.created_at, timeZone)}]`;
        if (r.role === "user") return `${at} Rosie：${text}`;
        return `${at} 清然：${spoken ? keepLabels(text) : text.trim()}`;
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

/**
 * One day (or, with `upto`, the day so far: a fold). A day folded earlier is only read from where the fold stopped,
 * so nothing is put into his memory twice.
 */
export async function runNight(
  day: string,
  jobId?: string,
  complete: typeof callModel = callModel,
  opts: { upto?: number } = {},
): Promise<{ ok: boolean; skipped?: string }> {
  const at = now();
  const tz = resolveTz((await getMeta()).timeZone);
  const window = dayWindow(day, tz);
  const folded = Number(await getMark(`day:${day}:upto`)) || 0;
  const from = Math.max(window.from, folded);
  const to = opts.upto ? Math.min(opts.upto, window.to) : window.to;
  const [rows, profileData, charter, us, ident] = await Promise.all([
    dayMessages(from, to),
    getProfileData(),
    getProfilePrompt(),
    dossierTextForModel(),
    readIdentity(),
  ]);
  if (!rows.length) {
    if (opts.upto) return { ok: true, skipped: "empty" };
    await setMark(`day:${day}`, folded ? "done" : "empty", at);
    return { ok: true, skipped: "empty" };
  }
  const profile = lockedProfile(profileData);
  await syncStory(profile.storyline);
  const conversation = nightConversation(rows, tz);
  // Every event and understanding so far (not the storyline, not his ｛｝ notes): the day may continue one of them.
  const known = (await listMemories()).filter((m) => m.source === "night" || m.source === "rosie").slice(-NIGHT_MEMORIES);
  const loaded = await loadPrompt("editor");
  const messages = renderVariant(parsePromptBody("editor", loaded.body), "main", {
    system_prompt: charter,
    identity_block: identityBlock(ident.identity) ? `${identityBlock(ident.identity)}\n` : "",
    us: us.trim() || "（还没有）",
    memories: memoriesWithIds(known) || "（没有）",
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
  // A known id rewrites that event or understanding whole (the topic continued today); anything else is new.
  const knownIds = new Set(known.map((m) => m.id));
  const fresh: NewMemory[] = [];
  const keep = async (raw: unknown, kind: "moment" | "insight") => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const body = str(item.body);
    if (!body) return;
    const id = Number(item.id);
    const atMs = dayClockMs(day, str(item.time), tz) ?? (kind === "insight" ? window.to - 1 : window.from);
    const fields = {
      body,
      keys: str(item.keys),
      thread: str(item.thread),
      importance: Number(item.importance),
      // What 清然 understood is his; an event can be someone else's (he was not there and nobody told him).
      knows: kind === "insight" ? "" : str(item.knows),
    };
    if (knownIds.has(id)) await updateMemory(id, { ...fields, day, at: atMs });
    else fresh.push({ kind, source: "night", day, at: atMs, ...fields });
  };
  for (const raw of Array.isArray(json.events) ? json.events : []) await keep(raw, "moment");
  for (const raw of Array.isArray(json.insights) ? json.insights : []) await keep(raw, "insight");
  await addMemories(fresh);
  const complaints = (Array.isArray(json.feedback) ? json.feedback : [])
    .map((raw) => (raw ?? {}) as Record<string, unknown>)
    .filter((item) => str(item.body))
    .map((item) => ({ day, at: dayClockMs(day, str(item.time), tz) ?? window.from, body: str(item.body) }));
  await addFeedback(complaints, at);
  const nextUs = str(json.us);
  if (nextUs) await publishMemory(nextUs, "night", Math.min(window.to, at), { day, changes: str(json.changes).slice(0, 1000) });
  if (from > window.from) await appendDayTimeline(day, str(json.timeline), at);
  else await saveDayTimeline(day, str(json.timeline), at);
  if (opts.upto) await setMark(`day:${day}:upto`, String(to), at);
  else await setMark(`day:${day}`, "done", at);
  await embedMissing().catch(() => 0);
  await appendInnerLog({ turnSeq: 0, data: { kind: "night", day, output: result.json }, model: result.model, ms: result.ms });
  return { ok: true };
}

/**
 * Today's talk grew past what the reply is given: fold the day so far into his memory now, then the reply starts
 * again from `keepFrom` (the last few messages). A day whose night pass already ran is not folded again.
 */
export async function foldTalk(day: string, upto: number, keepFrom: number, jobId?: string): Promise<void> {
  // A day already in his memory (night pass done, imported, empty) is not folded again.
  if (!(await getMark(`day:${day}`))) await runNight(day, jobId, callModel, { upto });
  if (Number.isFinite(keepFrom) && keepFrom > 0) await patchMeta({ contextFrom: keepFrom });
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
       -- a fold of that day still waiting or running goes first, so the two never read the same stretch
       and not exists (select 1 from brain_jobs j where j.dedupe_key like 'fold:' || qingran_messages.local_day || ':%'
                        and j.status in ('pending', 'running'))
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

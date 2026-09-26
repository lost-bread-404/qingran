import { callModel, type CallModelResult } from "./llm.ts";
import { now } from "./clock.ts";
import { appendInnerLog, getMeta, getProfileData, getProfilePrompt, patchBrainLog, sql } from "./store.ts";
import { resolveTz } from "./tz.ts";
import { localDay, shiftDay, zonedParts } from "./time.ts";
import { lockedProfile, type TalkModeDef } from "../types.ts";
import { isNightNoiseBody, modelFacingText } from "../message-markup.ts";
import { parsePromptBody, renderVariant } from "./prompts/doc.ts";
import { loadPrompt } from "./prompts/store.ts";
import { dossierTextForModel, publishMemory } from "./dossier.ts";
import { identityBlock } from "./life.ts";
import { readIdentity } from "./life-store.ts";
import { enqueue } from "./jobs.ts";
import { spokenOnly } from "./voice/pack-build.ts";
import { parsePlans } from "./voice/reflector.ts";
import { clockOf, dayNotes } from "./day-notes.ts";
import { dayWindow, getHeart, hasDay, listPlans, plansText, replaceMindPlans, saveDayTimeline, setHeart } from "./heart.ts";

/**
 * The night pass: once a day after 04:00 local, fold the day that just ended into his memory.
 * One call rewrites the whole memory, writes the day's timeline, keeps tomorrow's plans and sets how he wakes up.
 */
export const NIGHT_SCHEMA = {
  name: "night",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["memory", "timeline", "plans", "heart"] as string[],
    properties: {
      memory: { type: "string" },
      timeline: { type: "string" },
      plans: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "at"],
          properties: { text: { type: "string" }, at: { type: "string" } },
        },
      },
      heart: { type: "string" },
    },
  },
};

/** Cap on the day's conversation sent at night. Past this, his lines keep only what he said aloud. */
const NIGHT_CONVERSATION_MAX = 60_000;
/** The night pass runs from 04:00 until noon local, for the day that ended at 04:00. */
const NIGHT_FROM_HOUR = 4;
const NIGHT_UNTIL_HOUR = 12;

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

/** Which mode was on at each moment, from the mode log. */
async function modeTimeline(to: number): Promise<Array<{ at: number; mode: string }>> {
  const db = await sql();
  const rows = await db.query<{ at: number; mode: string }>(
    `select at::float8 as at, mode from qr_mode_log where at < $1 order by at asc, id asc`,
    [to],
  );
  return rows.map((r) => ({ at: Number(r.at), mode: String(r.mode) }));
}

function modeAtTime(log: Array<{ at: number; mode: string }>, at: number): string | null {
  let current: string | null = null;
  for (const row of log) {
    if (row.at > at) break;
    current = row.mode;
  }
  return current;
}

export function nightConversation(
  rows: Row[],
  modes: TalkModeDef[],
  log: Array<{ at: number; mode: string }>,
  timeZone: string,
): string {
  const quiet = new Set(modes.filter((m) => !m.keepActions).map((m) => m.id));
  const render = (allSpoken: boolean) =>
    rows
      .filter((r) => !isNightNoiseBody(r.body))
      .map((r) => {
        const text = modelFacingText(r.body);
        const mode = modeAtTime(log, r.created_at);
        const body = r.role === "assistant" && (allSpoken || (mode != null && quiet.has(mode))) ? spokenOnly(text) : text;
        return `[${clockOf(r.created_at, timeZone)}] ${r.role === "user" ? "Rosie" : "清然"}：${body}`;
      })
      .join("\n");
  let text = render(false);
  if (text.length > NIGHT_CONVERSATION_MAX) text = render(true);
  if (text.length > NIGHT_CONVERSATION_MAX) text = text.slice(-NIGHT_CONVERSATION_MAX);
  return text;
}

/** `manual` (整理今天 in the middle of the day) only rewrites the memory and today's timeline; plans and heart stay. */
export async function runNight(
  day: string,
  jobId?: string,
  complete: typeof callModel = callModel,
  opts: { manual?: boolean } = {},
): Promise<{ ok: boolean; skipped?: string }> {
  const at = now();
  const tz = resolveTz((await getMeta()).timeZone);
  const window = dayWindow(day, tz);
  const [rows, notes, profileData, charter, dossier, ident, heart, plans, modeLog] = await Promise.all([
    dayMessages(window.from, window.to),
    dayNotes(window.from, window.to),
    getProfileData(),
    getProfilePrompt(),
    dossierTextForModel(),
    readIdentity(),
    getHeart(),
    listPlans(),
    modeTimeline(window.to),
  ]);
  if (!rows.length && !notes.length) {
    await saveDayTimeline(day, "", at);
    return { ok: true, skipped: "empty" };
  }
  const profile = lockedProfile(profileData);
  const loaded = await loadPrompt("editor");
  const messages = renderVariant(parsePromptBody("editor", loaded.body), "main", {
    system_prompt: charter,
    identity_block: identityBlock(ident.identity) ? `${identityBlock(ident.identity)}\n` : "",
    story: profile.storyline.trim() || "（没有）",
    dossier: dossier.trim() || "（还没有）",
    heart: heart.text.trim() || "（空）",
    plans: plansText(plans, at, tz) || "（没有）",
    notes: notes.map((n) => `${clockOf(n.at, tz)} ${n.text}`).join("\n") || "（没有）",
    day,
    conversation: nightConversation(rows, profile.modes, modeLog, tz) || "（没有）",
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
  const memory = typeof json.memory === "string" ? json.memory.trim() : "";
  if (memory) await publishMemory(memory, "night", Math.min(window.to, at), { day });
  await saveDayTimeline(day, typeof json.timeline === "string" ? json.timeline.trim() : "", at);
  if (!opts.manual) {
    await replaceMindPlans(parsePlans(json.plans, tz, at), at, "night");
    const wake = typeof json.heart === "string" ? json.heart.trim() : "";
    if (wake) await setHeart(wake, at);
  }
  await appendInnerLog({ turnSeq: 0, data: { kind: "night", day, output: result.json }, model: result.model, ms: result.ms });
  return { ok: true };
}

/** Called from the 10-minute wake: after 04:00, the day that just ended gets its night pass once. */
export async function enqueueNightIfDue(at = now()): Promise<string | null> {
  const tz = resolveTz((await getMeta()).timeZone);
  const hour = zonedParts(at, tz).hour;
  if (hour < NIGHT_FROM_HOUR || hour >= NIGHT_UNTIL_HOUR) return null;
  const day = shiftDay(localDay(at, tz), -1);
  if (await hasDay(day, dayWindow(day, tz).to)) return null;
  await enqueue("night", `night:${day}`, { day });
  return day;
}

/** "整理今天" in settings: fold today in now, without waiting for the night. */
export async function enqueueNightNow(at = now()): Promise<string> {
  const tz = resolveTz((await getMeta()).timeZone);
  const day = localDay(at, tz);
  await enqueue("night", `night:manual:${at}`, { day, manual: true }, at, true);
  return day;
}

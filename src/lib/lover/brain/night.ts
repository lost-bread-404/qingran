import { callModel, type CallModelResult } from "./llm.ts";
import { now } from "./clock.ts";
import { clampVoiceEffort, voiceSafetyPick } from "./config.ts";
import { isClaudeModel } from "../claude.ts";
import { appendInnerLog, getMeta, getProfileData, patchBrainLog, sql } from "./store.ts";
import { resolveTz } from "./tz.ts";
import { localDay, zonedParts } from "./time.ts";
import { lockedProfile, personaText } from "../types.ts";
import { fromStored, modelFacingText } from "../message-meta.ts";
import { parsePromptBody, renderVariant } from "./prompts/doc.ts";
import { loadPrompt } from "./prompts/store.ts";
import { dossierTextForModel, publishMemory } from "./dossier.ts";
import { readIdentity } from "./life-store.ts";
import { enqueue } from "./jobs.ts";
import { saveDayTimeline } from "./heart.ts";
import { addFeedback, getMark, listMemories, setMark } from "./memory.ts";
import { dayStart, lastSleepAfter } from "./sleep.ts";

/**
 * The night pass (docs/brain.md v7). Once she has slept, Claude (highest effort) reads yesterday's dossier, the
 * whole day she just had and the week before it, every line with its time, and writes:
 * - the new dossier (≤ 500 characters): what still changes how 清然 thinks and acts, and how 清然 sees Rosie;
 * - feedback: Rosie's complaints about 清然, for her only (qr_feedback), never shown to 清然;
 * - the day's timeline (monthly report).
 * There is no memory library any more: the talk itself, with its times, is the record.
 */

const WEEK_MS = 7 * 24 * 60 * 60_000;
/** Safety caps on what one night reads (characters); the oldest of the week goes first. */
const TODAY_MAX_CHARS = 150_000;
const WEEK_MAX_CHARS = 250_000;
/** The mark: the last message a night pass has covered. */
const NIGHT_UPTO = "night:upto";
/** Set when the old memory library and storyline were folded into the dossier (done once). */
const LEGACY_FOLDED = "night:legacy-folded";
/** Set when the highest effort ran out of time: the next try uses high. */
const NIGHT_SLOW = "night:slow";

type Row = { id: string; role: string; body: string; meta: unknown; created_at: number };

async function messagesBetween(from: number, to: number): Promise<Row[]> {
  const db = await sql();
  const rows = await db.query<Row>(
    `select id, role, body, meta, created_at::float8 as created_at from qingran_messages
     where created_at >= $1 and created_at <= $2 and forgotten_at is null and kind is distinct from 'system_notice'
     order by created_at asc, id asc`,
    [from, to],
  );
  return rows.map((r) => ({ ...r, created_at: Number(r.created_at) }));
}

function stamp(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.month}/${p.day} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** One line per message, with date and time; the newest kept when it is too long. */
export function nightConversation(rows: Row[], timeZone: string, maxChars: number): string {
  const lines = rows
    .map((r) => ({ ...r, ...fromStored(r.body, r.meta) }))
    .filter((r) => !r.meta.nightNoise)
    .map((r) => `[${stamp(r.created_at, timeZone)}] ${r.role === "user" ? "Rosie" : "清然"}：${modelFacingText(r).trim()}`);
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(-maxChars);
  return text;
}

async function innerNotes(from: number, to: number, timeZone: string): Promise<string> {
  const db = await sql();
  const rows = await db.query<{ body: string; at: number | string }>(
    `select body, at from qr_memories where source = 'inner' and at >= $1 and at <= $2 order by at asc, id asc`,
    [from, to],
  );
  return rows.map((r) => `[${stamp(Number(r.at), timeZone)}] ${String(r.body).trim()}`).join("\n");
}

/** The old memory library and storyline, once, so the first new dossier keeps what still matters from them. */
async function legacyText(storyline: string): Promise<string> {
  const memories = (await listMemories()).filter((m) => m.source !== "inner");
  const lines = memories.map((m) => `- ${m.day ? `${m.day} ` : ""}${m.body.trim()}`);
  return [storyline.trim() ? `故事线：\n${storyline.trim()}` : "", lines.length ? `回忆：\n${lines.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

function tag(text: string, name: string): string | null {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1]!.trim() : null;
}

/**
 * One night: the day that ended with the message at `upto`. `dossierOnly` (设置 → 记忆 →「现在整理一次」): the day
 * so far, only the dossier is rewritten (no feedback, no timeline, the night mark does not move).
 */
export async function runNight(upto: number, jobId?: string, opts: { dossierOnly?: boolean } = {}): Promise<{ ok: boolean; skipped?: string }> {
  const at = now();
  const tz = resolveTz((await getMeta()).timeZone);
  const from = await dayStart(upto, tz);
  const [today, week, profileData, us, ident, legacyDone, slow] = await Promise.all([
    messagesBetween(from, upto),
    messagesBetween(from - WEEK_MS, from - 1),
    getProfileData(),
    dossierTextForModel(),
    readIdentity(),
    getMark(LEGACY_FOLDED),
    getMark(NIGHT_SLOW),
  ]);
  if (!today.length) {
    if (!opts.dossierOnly) await setMark(NIGHT_UPTO, String(upto), at);
    return { ok: true, skipped: "empty" };
  }
  const profile = lockedProfile(profileData);
  const legacy = legacyDone ? "" : await legacyText(profile.storyline);
  const loaded = await loadPrompt("editor");
  const messages = renderVariant(parsePromptBody("editor", loaded.body), "main", {
    system_prompt: personaText(profile),
    identity: ident.identity.trim(),
    us: us.trim(),
    legacy,
    week: nightConversation(week, tz, WEEK_MAX_CHARS),
    today: nightConversation(today, tz, TODAY_MAX_CHARS),
    inner: await innerNotes(from, upto, tz),
    max_chars: String(profile.dossierMaxChars),
  });
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const users = messages.filter((m) => m.role !== "system").map((m) => m.content);
  // Her pick (设置 → 记忆); once the highest effort has run out of time, the next try steps down to high.
  const picked = clampVoiceEffort(profile.nightModel, profile.nightEffort);
  const effort = slow && (picked === "max" || picked === "xhigh") ? "high" : picked;
  const ask = (model: string, eff: typeof effort) =>
    callModel("editor", {
      system,
      input: users.join("\n\n"),
      inputParts: users,
      jobId,
      promptKey: loaded.key,
      promptHash: loaded.hash,
      model,
      effort: eff,
      outputRef: `night:${upto}`,
    });
  let result: CallModelResult = await ask(profile.nightModel, effort);
  let dossier = result.ok ? tag(result.text, "dossier") : null;
  // Claude declines the explicit parts of her day (10/5: three refusals at 05:00, the day was lost). Grok reads the
  // same material at once, as Grok stands in for the day reply. A timeout is left to the retry (it steps down to high).
  if (!dossier && isClaudeModel(profile.nightModel) && result.failKind !== "timeout") {
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
    const grok = voiceSafetyPick();
    result = await ask(grok.model, grok.effort);
    dossier = result.ok ? tag(result.text, "dossier") : null;
  }
  if (!dossier) {
    if (result.failKind === "timeout" && !slow) await setMark(NIGHT_SLOW, "1", at);
    await appendInnerLog({ turnSeq: 0, data: { kind: "night", upto, error: result.failKind ?? "no-dossier" }, model: result.model, ms: result.ms });
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
    throw new Error(`night:${result.failKind ?? "no-dossier"}`);
  }
  if (slow) await setMark(NIGHT_SLOW, "", at);
  const day = localDay(from, tz);
  await publishMemory(dossier.slice(0, profile.dossierMaxChars + 100), "night", upto, { upto, dossierOnly: Boolean(opts.dossierOnly) });
  if (legacy) await setMark(LEGACY_FOLDED, String(at), at);
  if (!opts.dossierOnly) {
    const complaints = (tag(result.text, "feedback") ?? "")
      .split("\n")
      .map((line) => line.replace(/^[-•·\s]+/, "").trim())
      .filter(Boolean)
      .map((body) => ({ day, at: upto, body }));
    await addFeedback(complaints, at);
    await saveDayTimeline(day, tag(result.text, "timeline") ?? "", at);
    await setMark(NIGHT_UPTO, String(upto), at);
  }
  await appendInnerLog({ turnSeq: 0, data: { kind: "night", upto, day, output: result.text }, model: result.model, ms: result.ms });
  return { ok: true };
}

/** Called after each reply and from the wake: once she has slept, the day before the sleep gets its night pass. */
export async function enqueueMemoryWork(at = now()): Promise<string | null> {
  const profile = lockedProfile(await getProfileData());
  if (!profile.brainOn) return null;
  const tz = resolveTz((await getMeta()).timeZone);
  const done = Number(await getMark(NIGHT_UPTO)) || 0;
  const upto = await lastSleepAfter(done, at, tz);
  if (upto == null || upto <= done) return null;
  await enqueue("night", `night:${upto}`, { v: 7, upto });
  return localDay(upto, tz);
}

/** 设置 → 记忆 →「现在整理一次」: the dossier rewritten from the day so far (and, the first time, the old memories). */
export async function runNightNow(at = now()): Promise<void> {
  await runNight(at, undefined, { dossierOnly: true });
}

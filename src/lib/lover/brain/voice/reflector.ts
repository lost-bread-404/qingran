import { REFLECT_WINDOW } from "../config.ts";
import { callModel, classifyReflectFailure, type CallModelResult } from "../llm.ts";
import {
  appendInnerLog,
  getInner,
  getMeta,
  getProfilePrompt,
  listHistoryWindow,
  patchBrainLog,
  saveInner,
  getProfileData,
  sql,
} from "../store.ts";
import { formatClock } from "../time.ts";
import { now } from "../clock.ts";
import { fillReflectTurn } from "../observability.ts";
import { patchTurnTraceReflector } from "../turn-trace.ts";
import { isNightNoiseBody, modelFacingText } from "../../message-markup.ts";
import { rememberBlock, rememberCharter, type ReflectRefs } from "../log-refs.ts";
import { resolveTz } from "../tz.ts";
import type { InnerState, StoredMessage } from "../types.ts";
import { parsePromptBody, renderVariant } from "../prompts/doc.ts";
import { loadPrompt } from "../prompts/store.ts";
import { dossierTextForModel } from "../dossier.ts";
import { busyContextLine, clampInHours, identityBlock } from "../life.ts";
import { currentBusy } from "../busy.ts";
import { lockedProfile } from "../../types.ts";
import { listReachPlans, readIdentity, replaceReachPlans } from "../life-store.ts";
import { latestMode, modeAt, modeFacts, recordMode, type TalkMode } from "../mode.ts";
import { addDayNote } from "../day-notes.ts";

export const INNER_SCHEMA = {
  name: "inner",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["thought", "scene", "reaches", "mode", "until_hours", "mode_why", "feedback", "day_note"],
    properties: {
      day_note: { type: "string" },
      feedback: { type: "string" },
      thought: { type: "string" },
      mode: { type: "string", enum: ["play", "real"] },
      until_hours: { anyOf: [{ type: "null" }, { type: "number" }] },
      mode_why: { type: "string" },
      scene: { type: "string", enum: ["daily", "intimate"] },
      reaches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["in_hours", "intent"],
          properties: {
            in_hours: { type: "number" },
            intent: { type: "string" },
          },
        },
      },
    },
  },
};

const THOUGHTS_MAX = 12;

/** Recent non-empty thoughts since the last room clear, oldest first. */
export async function recentThoughts(timeZone: string): Promise<string> {
  const db = await sql();
  const rows = await db.query<{ created_at: number; thought: string }>(
    `select l.created_at::float8 as created_at, l.data->'output'->>'thought' as thought
     from qr_inner_log l
     where l.data->>'kind' = 'reflect'
       and coalesce(l.data->'output'->>'thought', '') <> ''
       and l.created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
     order by l.id desc limit $1`,
    [THOUGHTS_MAX],
  );
  return rows
    .reverse()
    .map((row) => `[${formatClock(Number(row.created_at), timeZone)}] ${String(row.thought).trim()}`)
    .join("\n");
}

const MAX_REST_HOURS = 14;

/** Mode for her next message. A rest with an end time also books the call to bring her back. */
async function applyModeDecision(json: Record<string, unknown>, at: number, tz: string): Promise<void> {
  const mode: TalkMode | null = json.mode === "real" ? "real" : json.mode === "play" ? "play" : null;
  if (!mode) return;
  const hours = typeof json.until_hours === "number" && json.until_hours > 0 ? Math.min(json.until_hours, MAX_REST_HOURS) : null;
  const until = mode === "play" && hours != null ? Math.round(at + hours * 3_600_000) : null;
  const why = typeof json.mode_why === "string" ? json.mode_why.trim() : "";
  const last = await latestMode();
  const current = modeAt(last, at, tz);
  const untilMoved = until != null && (last?.until == null || Math.abs(last.until - until) > 10 * 60_000);
  if (mode === current && !untilMoved) return;
  await recordMode({ at, mode, until, why });
  await replaceReachPlans(
    ["mode"],
    until != null ? [{ at: until, intent: `休息时间到了，去把她叫回来。${why}` }] : [],
    "mode",
    at,
  );
}

const MAX_REACH_PLANS = 5;
/** Plans the mind may rewrite each turn. The end-of-rest wake and Rosie's own plans are left alone. */
const MIND_PLAN_AUTHORS = ["reflect", "reach", "planned", "random", "manual"];

/** reflect gives the full list of plans it still means to keep; it replaces its own earlier ones. */
async function applyReaches(json: Record<string, unknown>, at: number): Promise<void> {
  if (!Array.isArray(json.reaches)) return;
  const plans = json.reaches
    .map((raw) => (raw && typeof raw === "object" ? (raw as { in_hours?: unknown; intent?: unknown }) : null))
    .filter((raw): raw is { in_hours: number; intent?: unknown } => raw != null && typeof raw.in_hours === "number" && raw.in_hours > 0)
    .slice(0, MAX_REACH_PLANS)
    .map((raw) => ({
      at: at + clampInHours(raw.in_hours) * 3_600_000,
      intent: typeof raw.intent === "string" ? raw.intent.trim() : "",
    }));
  await replaceReachPlans(MIND_PLAN_AUTHORS, plans, "reflect", at);
}

/** What he already means to do, so the mind can keep, move or drop each plan. */
export async function pendingReachLine(at: number, tz: string): Promise<string> {
  const plans = await listReachPlans();
  if (!plans.length) return "我打算找她的：（没有）";
  const lines = plans.map((plan) => {
    const hours = Math.max(0, (plan.at - at) / 3_600_000);
    const who = plan.setBy === "mode" ? "（休息结束叫她）" : plan.setBy === "rosie" ? "（她定的）" : "";
    return `${formatClock(plan.at, tz)}（约 ${hours.toFixed(1)} 小时后）${plan.intent || "（没写）"}${who}`;
  });
  return `我打算找她的：\n${lines.join("\n")}`;
}

/** One plain sentence about her day, stamped at her last message. */
async function applyDayNote(json: Record<string, unknown>, history: StoredMessage[]): Promise<void> {
  const text = typeof json.day_note === "string" ? json.day_note.trim() : "";
  if (!text) return;
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  await addDayNote(lastUser?.createdAt ?? now(), text);
}

export function formatReflectConversation(history: StoredMessage[], timeZone: string): string {
  const lines = history
    .filter((m) => m.kind !== "system_notice" && !isNightNoiseBody(m.text))
    .map((m) => `[${formatClock(m.createdAt, timeZone)}] ${m.role === "user" ? "Rosie" : "清然"}：${modelFacingText(m.text)}`);
  return lines.join("\n");
}

export type ReflectorParts = {
  charter: string;
  identity?: string;
  story: string;
  dossier: string;
  clock: string;
  busyLine?: string;
  thoughts: string;
  conversation: string;
  routine?: string;
  modeFacts?: string;
};

export type ReflectorPacked = { system: string; stable: string; turn: string };

export function reflectVars(parts: ReflectorParts): Record<string, string> {
  return {
    system_prompt: parts.charter,
    identity_block: parts.identity?.trim() ? `${parts.identity.trim()}\n` : "",
    story: parts.story.trim() || "（没有）",
    dossier: parts.dossier.trim() || "（还没有）",
    clock: parts.clock,
    busy_line: parts.busyLine?.trim() ?? "",
    thoughts: parts.thoughts.trim() || "（还没有）",
    mode_facts: parts.modeFacts?.trim() || "（没有）",
    conversation: parts.conversation.trim() || "（还没有）",
  };
}

/** A = system, B = story + memory (cacheable), C = clock + thoughts + conversation. */
export function buildReflectorInput(parts: ReflectorParts, template?: string | null): ReflectorPacked {
  const messages = renderVariant(parsePromptBody("reflect", template), "main", reflectVars(parts));
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  const users = messages.filter((message) => message.role !== "system");
  return {
    system,
    stable: users[0]?.content ?? "",
    turn: users.slice(1).map((message) => message.content).join("\n\n"),
  };
}

export async function runReflector(
  turnSeq: number,
  jobId?: string,
  complete: typeof callModel = callModel,
): Promise<InnerState | null> {
  const old = await getInner();
  if (old.turn_seq >= turnSeq) return old;

  const at = now();
  const [meta, history, systemPrompt, dossier, ident, busy, profileData] = await Promise.all([
    getMeta(),
    listHistoryWindow(null, REFLECT_WINDOW),
    getProfilePrompt(),
    dossierTextForModel(),
    readIdentity(),
    currentBusy(at),
    getProfileData(),
  ]);
  const profile = lockedProfile(profileData);
  const tz = resolveTz(meta.timeZone);
  const convo = formatReflectConversation(history, tz);
  const clockText = formatClock(at, tz);
  const [thoughts, facts, plansLine] = await Promise.all([recentThoughts(tz), modeFacts(at, tz), pendingReachLine(at, tz)]);
  const modeFactsText = `${facts}\n${plansLine}`;
  const loaded = await loadPrompt("reflect");
  const packed = buildReflectorInput(
    {
      charter: systemPrompt,
      identity: identityBlock(ident.identity),
      story: profile.storyline,
      dossier,
      clock: clockText,
      busyLine: busyContextLine(busy),
      thoughts,
      conversation: convo,
      modeFacts: modeFactsText,
    },
    loaded.body,
  );

  const [charterHash, blockBHash] = await Promise.all([
    rememberCharter(systemPrompt),
    rememberBlock("reflect_b", packed.stable),
  ]);
  const refs: ReflectRefs = {
    charterHash,
    blockBHash,
    relatedIds: [],
    oldMindTurnSeq: old.turn_seq,
    oldInnerText: thoughts,
    recentMessageIds: history.map((m) => m.id),
    clockText,
    timeZone: tz,
  };

  const result: CallModelResult = await complete("reflect", {
    system: packed.system,
    input: packed.stable,
    inputParts: [packed.stable, packed.turn],
    schema: INNER_SCHEMA,
    jobId,
    turnSeq,
    refs,
    outputRef: `inner:${turnSeq}`,
    promptKey: loaded.key,
    promptHash: loaded.hash,
  });
  if (!result.ok || !result.json) {
    await appendInnerLog({
      turnSeq,
      data: { kind: "reflect", error: classifyReflectFailure(result) },
      model: result.model,
      ms: result.ms,
    });
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
    await fillReflectTurn(turnSeq, false, result.ms, classifyReflectFailure(result));
    await patchTurnTraceReflector({ turnSeq, inner: null, model: result.model, ms: result.ms });
    return null;
  }
  const json = result.json as Record<string, unknown>;
  const thought = typeof json.thought === "string" ? json.thought.trim().slice(0, 1200) : "";
  const next: InnerState = {
    ...old,
    desire: "",
    readHer: "",
    feel: "",
    choice: "",
    // His state + read of her carries across turns until the mind writes a new one; it lapses after THOUGHT_TTL_MS (16h).
    now: thought || old.now,
    scene: json.scene === "intimate" ? "intimate" : "daily",
    turn_seq: turnSeq,
    updated_at: at,
  };
  await applyReaches(json, at);
  await applyModeDecision(json, at, tz);
  await applyDayNote(json, history);
  const saved = await saveInner(next, turnSeq, {
    model: result.model,
    ms: result.ms,
    log: { kind: "reflect", output: result.json },
  });
  if (!saved) {
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
  }
  await fillReflectTurn(turnSeq, saved, result.ms, saved ? null : "stale");
  await patchTurnTraceReflector({
    turnSeq,
    inner: saved ? next : null,
    model: result.model,
    ms: result.ms,
  });
  return saved ? next : old;
}

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
import { readIdentity, saveReach } from "../life-store.ts";

export const INNER_SCHEMA = {
  name: "inner",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["thought", "scene", "next_reach"],
    properties: {
      thought: { type: "string" },
      scene: { type: "string", enum: ["daily", "intimate"] },
      next_reach: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["in_hours", "intent"],
            properties: {
              in_hours: { type: "number" },
              intent: { type: "string" },
            },
          },
        ],
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
  const thoughts = await recentThoughts(tz);
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
  const reach = json.next_reach as { in_hours?: unknown; intent?: unknown } | null | undefined;
  const next: InnerState = {
    ...old,
    desire: "",
    readHer: "",
    feel: "",
    choice: "",
    // Only a fresh thought reaches the next reply. Nothing new → nothing injected.
    now: thought,
    scene: json.scene === "intimate" ? "intimate" : "daily",
    turn_seq: turnSeq,
    updated_at: at,
  };
  if (reach !== undefined) {
    const hours = reach && typeof reach.in_hours === "number" ? clampInHours(reach.in_hours) : null;
    await saveReach({
      nextAt: hours == null ? null : at + hours * 3_600_000,
      intent: reach && typeof reach.intent === "string" ? reach.intent : "",
      setBy: "reflect",
      setAt: at,
      retry: 0,
    });
  }
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

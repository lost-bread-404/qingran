import { REFLECT_WINDOW } from "../config.ts";
import { callModel, classifyReflectFailure } from "../llm.ts";
import { applyReflectOutput, expireOpenPlans, formatOldInner } from "../mind-parse.ts";
import {
  appendInnerLog,
  getInner,
  getMeta,
  getProfilePrompt,
  listHistoryWindow,
  patchBrainLog,
  saveInner,
  saveInnerPlans,
} from "../store.ts";
import { formatClock } from "../time.ts";
import { now } from "../clock.ts";
import { fillReflectTurn } from "../observability.ts";
import { patchTurnTraceReflector } from "../turn-trace.ts";
import { isNightNoiseBody } from "../../message-markup.ts";
import { rememberBlock, rememberCharter, type ReflectRefs } from "../log-refs.ts";
import { resolveTz } from "../tz.ts";
import type { InnerState, StoredMessage } from "../types.ts";
import { parsePromptBody, renderVariant } from "../prompts/doc.ts";
import { loadPrompt } from "../prompts/store.ts";
import { dossierTextForModel } from "../dossier.ts";

const INNER_SCHEMA = {
  name: "inner",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["feel", "want", "choice", "now", "longing", "plans"],
    properties: {
      feel: { type: "string" },
      want: { type: "string" },
      choice: { type: "string" },
      now: { type: "string" },
      longing: { type: "string" },
      plans: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "what", "trigger", "expires_in_hours", "status"],
          properties: {
            id: { type: "string" },
            what: { type: "string" },
            trigger: { type: "string" },
            expires_in_hours: { type: "number" },
            status: { type: "string", enum: ["open", "done", "dropped"] },
          },
        },
      },
    },
  },
};

export function formatReflectConversation(history: StoredMessage[], timeZone: string): string {
  const lines = history
    .filter((m) => !isNightNoiseBody(m.text))
    .map((m) => `[${formatClock(m.createdAt, timeZone)}] ${m.role === "user" ? "Rosie" : "清然"}：${m.text}`);
  return lines.join("\n");
}

export type ReflectorParts = {
  charter: string;
  dossier: string;
  clock: string;
  oldInner: string;
  conversation: string;
};

export type ReflectorPacked = { system: string; stable: string; turn: string };

/** Data only. Headings live in the reflect template. */
export function reflectVars(parts: ReflectorParts): Record<string, string> {
  return {
    system_prompt: parts.charter,
    dossier: parts.dossier.trim() || "（还没有）",
    clock: parts.clock,
    old_inner: parts.oldInner.trim() || "（空）",
    conversation: parts.conversation.trim() || "（还没有）",
    self: "",
    bond: "",
    portrait: "",
    themes: "",
    findings: "",
    index_core: "",
    index_related: "",
    old_mind: parts.oldInner.trim() || "（空）",
  };
}

/** A = system, B = dossier user (cacheable), C = clock + old inner + conversation. */
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

export async function runReflector(turnSeq: number, jobId?: string): Promise<InnerState | null> {
  const loadedInner = await getInner();
  if (loadedInner.turn_seq >= turnSeq) return loadedInner;

  const at = now();
  const expired = expireOpenPlans(loadedInner.plans, at);
  if (expired.dropped.length) await saveInnerPlans(expired.plans);
  const old: InnerState = { ...loadedInner, plans: expired.plans };

  const [meta, history, systemPrompt, dossier] = await Promise.all([
    getMeta(),
    listHistoryWindow(null, REFLECT_WINDOW),
    getProfilePrompt(),
    dossierTextForModel(),
  ]);
  const tz = resolveTz(meta.timeZone);
  const convo = formatReflectConversation(history, tz);
  const clockText = formatClock(at, tz);
  const oldInnerText = formatOldInner(old, at);
  const loaded = await loadPrompt("reflect");
  const packed = buildReflectorInput(
    {
      charter: systemPrompt,
      dossier,
      clock: clockText,
      oldInner: oldInnerText,
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
    oldInnerText,
    recentMessageIds: history.map((m) => m.id),
    clockText,
    timeZone: tz,
  };

  const result = await callModel("reflect", {
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
      data: { error: classifyReflectFailure(result), expired_before: expired.dropped },
      model: result.model,
      ms: result.ms,
    });
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
    await fillReflectTurn(turnSeq, false, result.ms, classifyReflectFailure(result));
    await patchTurnTraceReflector({ turnSeq, inner: null, model: result.model, ms: result.ms });
    return null;
  }
  const applied = applyReflectOutput(old, result.json, at, turnSeq);
  if (expired.dropped.length) applied.discarded.expired_before = expired.dropped;
  const saved = await saveInner(applied.next, turnSeq, {
    model: result.model,
    ms: result.ms,
    log: { output: result.json, applied: applied.next, discarded: applied.discarded },
  });
  if (!saved) {
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
  }
  await fillReflectTurn(turnSeq, saved, result.ms, saved ? null : "stale");
  await patchTurnTraceReflector({
    turnSeq,
    inner: saved ? applied.next : null,
    model: result.model,
    ms: result.ms,
  });
  return saved ? applied.next : old;
}

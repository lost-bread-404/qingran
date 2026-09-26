import { REFLECT_WINDOW } from "../config.ts";
import { callModel, classifyReflectFailure, type CallModelResult } from "../llm.ts";
import { appendInnerLog, getInner, getMeta, getProfilePrompt, listHistoryWindow, patchBrainLog, getProfileData } from "../store.ts";
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
import { identityBlock } from "../life.ts";
import { lockedProfile, type TalkModeDef } from "../../types.ts";
import { readIdentity } from "../life-store.ts";
import { effectiveMode, recordMode } from "../mode.ts";
import { addDayNote } from "../day-notes.ts";
import { spokenOnly, VERBATIM_REPLIES } from "./pack-build.ts";
import {
  daysText,
  getHeart,
  listPlans,
  markSilenceSeen,
  parseLocalTime,
  plansText,
  recentDays,
  replaceMindPlans,
  setFocus,
  setHeart,
  timeFacts,
  todayNotesText,
} from "../heart.ts";

/**
 * The inner mind (brain v5). Runs after every reply, and once when she has gone quiet.
 * Output is free text: heart, the full plan list when it changed, the next mode, one note on her day.
 * Empty fields mean "no change", so most turns change nothing.
 */
export const INNER_SCHEMA = {
  name: "inner",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["heart", "focus", "plans_changed", "plans", "mode", "note"] as string[],
    properties: {
      heart: { type: "string" },
      focus: { type: "string" },
      plans_changed: { type: "boolean" },
      plans: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "at"],
          properties: {
            text: { type: "string" },
            at: { type: "string" },
          },
        },
      },
      mode: { type: "string" },
      note: { type: "string" },
    },
  },
};

export type ReflectKind = "turn" | "silence";

export function formatReflectConversation(history: StoredMessage[], timeZone: string): string {
  const rows = history.filter((m) => m.kind !== "system_notice" && !isNightNoiseBody(m.text));
  let kept = 0;
  const verbatim = new Set<number>();
  for (let i = rows.length - 1; i >= 0 && kept < VERBATIM_REPLIES; i -= 1) {
    if (rows[i]!.role === "assistant") {
      verbatim.add(i);
      kept += 1;
    }
  }
  return rows
    .map((m, i) => {
      const text = modelFacingText(m.text);
      const body = m.role === "assistant" && !verbatim.has(i) ? spokenOnly(text) : text;
      return `[${formatClock(m.createdAt, timeZone)}] ${m.role === "user" ? "Rosie" : "清然"}：${body}`;
    })
    .join("\n");
}

export function modesText(modes: TalkModeDef[], current: string): string {
  return modes
    .map((m) => `- ${m.id}（${m.name}）${m.id === current ? "【现在】" : ""}：${m.when.trim() || "（没写什么时候用）"}`)
    .join("\n");
}

export type ReflectorParts = {
  charter: string;
  identity?: string;
  story: string;
  dossier: string;
  trigger: string;
  facts: string;
  days: string;
  today: string;
  heart: string;
  focus?: string;
  plans: string;
  modes: string;
  conversation: string;
};

export type ReflectorPacked = { system: string; stable: string; turn: string };

export function reflectVars(parts: ReflectorParts): Record<string, string> {
  return {
    system_prompt: parts.charter,
    identity_block: parts.identity?.trim() ? `${parts.identity.trim()}\n` : "",
    story: parts.story.trim() || "（没有）",
    dossier: parts.dossier.trim() || "（还没有）",
    trigger: parts.trigger.trim() || "她刚说完话。",
    facts: parts.facts.trim() || "（没有）",
    days: parts.days.trim() || "（还没有）",
    today: parts.today.trim() || "（还没有）",
    heart: parts.heart.trim() || "（空）",
    focus: parts.focus?.trim() || "（没有，跟着她）",
    plans: parts.plans.trim() || "（没有）",
    modes: parts.modes.trim() || "（没有）",
    conversation: parts.conversation.trim() || "（还没有）",
  };
}

/** A = system, B = story + memory (cacheable), C = everything that changes each time. */
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

function gapText(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`;
}

/** Everything the mind reads, from the database. Shared with the prompt preview. */
export async function gatherReflectParts(at: number, kind: ReflectKind, silentSince?: number): Promise<{
  parts: ReflectorParts;
  history: StoredMessage[];
  tz: string;
  modes: TalkModeDef[];
  current: string;
  charter: string;
}> {
  const [meta, history, charter, dossier, ident, profileData, heart, plans] = await Promise.all([
    getMeta(),
    listHistoryWindow(null, REFLECT_WINDOW),
    getProfilePrompt(),
    dossierTextForModel(),
    readIdentity(),
    getProfileData(),
    getHeart(),
    listPlans(),
  ]);
  const profile = lockedProfile(profileData);
  const tz = resolveTz(meta.timeZone);
  const ids = profile.modes.map((m) => m.id);
  const [facts, days, today, current] = await Promise.all([
    timeFacts(at, tz, at + 1),
    recentDays(7),
    todayNotesText(at, tz),
    effectiveMode(at, tz, ids),
  ]);
  const trigger =
    kind === "silence" && silentSince
      ? `她已经 ${gapText(at - silentSince)} 没说话了。这是她沉默后，你心里过的一遍。`
      : "她刚说完话，你也刚回了她。";
  return {
    parts: {
      charter,
      identity: identityBlock(ident.identity),
      story: profile.storyline,
      dossier,
      trigger,
      facts,
      days: daysText(days),
      today,
      heart: heart.text,
      focus: heart.focus,
      plans: plansText(plans, at, tz),
      modes: modesText(profile.modes, current),
      conversation: formatReflectConversation(history, tz),
    },
    history,
    tz,
    modes: profile.modes,
    current,
    charter,
  };
}

type ParsedPlan = { at: number | null; text: string };

export function parsePlans(raw: unknown, tz: string, at: number): ParsedPlan[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
    .filter((item): item is Record<string, unknown> => item != null && typeof item.text === "string" && item.text.trim() !== "")
    .map((item) => {
      const when = parseLocalTime(item.at, tz);
      // A time already past means "now": keep it due rather than dropping it.
      return { text: String(item.text).trim().slice(0, 500), at: when == null ? null : Math.max(when, at - 60_000) };
    });
}

export async function runReflector(
  turnSeq: number,
  jobId?: string,
  complete: typeof callModel = callModel,
  opts: { kind?: ReflectKind; silentSince?: number } = {},
): Promise<InnerState | null> {
  const kind = opts.kind ?? "turn";
  const heartBefore = await getHeart();
  if (kind === "turn" && heartBefore.turnSeq >= turnSeq) return getInner();

  const at = now();
  const gathered = await gatherReflectParts(at, kind, opts.silentSince);
  const { parts, history, tz, modes, current, charter } = gathered;
  const loaded = await loadPrompt("reflect");
  const packed = buildReflectorInput(parts, loaded.body);

  const [charterHash, blockBHash] = await Promise.all([rememberCharter(charter), rememberBlock("reflect_b", packed.stable)]);
  const refs: ReflectRefs = {
    charterHash,
    blockBHash,
    relatedIds: [],
    oldMindTurnSeq: heartBefore.turnSeq,
    oldInnerText: heartBefore.text,
    recentMessageIds: history.map((m) => m.id),
    clockText: formatClock(at, tz),
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
      data: { kind: kind === "silence" ? "reflect_silence" : "reflect", error: classifyReflectFailure(result) },
      model: result.model,
      ms: result.ms,
    });
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
    if (kind === "turn") {
      await fillReflectTurn(turnSeq, false, result.ms, classifyReflectFailure(result));
      await patchTurnTraceReflector({ turnSeq, inner: null, model: result.model, ms: result.ms });
    }
    return null;
  }

  const json = result.json as Record<string, unknown>;
  const heart = typeof json.heart === "string" ? json.heart.trim() : "";
  await setHeart(heart || heartBefore.text, at, kind === "turn" ? turnSeq : undefined);
  await setFocus(typeof json.focus === "string" ? json.focus.trim() : "");
  if (json.plans_changed === true) await replaceMindPlans(parsePlans(json.plans, tz, at), at);
  const mode = typeof json.mode === "string" ? json.mode.trim() : "";
  if (mode && mode !== current && modes.some((m) => m.id === mode)) {
    await recordMode({ at, mode, until: null, why: kind === "silence" ? "她沉默时想的" : "" });
  }
  const note = typeof json.note === "string" ? json.note.trim() : "";
  if (note) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    await addDayNote(kind === "silence" ? at : (lastUser?.createdAt ?? at), note);
  }
  if (kind === "silence" && opts.silentSince) await markSilenceSeen(opts.silentSince);

  await appendInnerLog({
    turnSeq,
    data: { kind: kind === "silence" ? "reflect_silence" : "reflect", output: result.json },
    model: result.model,
    ms: result.ms,
  });
  const inner = await getInner();
  if (kind === "turn") {
    await fillReflectTurn(turnSeq, true, result.ms, null);
    await patchTurnTraceReflector({ turnSeq, inner, model: result.model, ms: result.ms });
  }
  return inner;
}

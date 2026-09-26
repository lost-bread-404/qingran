import { REFLECT_WINDOW } from "../config.ts";
import { callModel, classifyReflectFailure, type CallModelResult } from "../llm.ts";
import { appendInnerLog, getInner, getMeta, getProfilePrompt, listHistoryWindow, patchBrainLog, getProfileData } from "../store.ts";
import { formatClock, localDay } from "../time.ts";
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
import { spokenOnly, VERBATIM_REPLIES } from "./pack-build.ts";
import {
  dayWindow,
  daysText,
  getHeart,
  hasDay,
  listPlans,
  markSilenceSeen,
  parseLocalTime,
  plansText,
  recentDays,
  replaceMindPlans,
  saveDayTimeline,
  setFocus,
  setHeart,
  timeFacts,
  todayText,
} from "../heart.ts";

/**
 * The inner mind (brain v5). One mind, three moments:
 * - turn: after every reply — heart, focus, plans, next mode;
 * - silence: once when she has gone quiet — the same, plus today's text rewritten with the stretch that just ended;
 * - due: a timed plan came due while she is away — the same, plus the message he sends her (or none).
 * Empty fields mean "no change", so most turns change nothing.
 */
export const INNER_SCHEMA = {
  name: "inner",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["heart", "focus", "plans_changed", "plans", "mode", "today", "message"] as string[],
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
      today: { type: "string" },
      message: { type: "string" },
    },
  },
};

export type ReflectKind = "turn" | "silence" | "due";

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

/** A silence covers this many messages at most (the stretch since the last silence, from 04:00 today). */
const SILENCE_WINDOW = 120;

/** Why the mind is thinking now. `due` passes its own text (what came due, and how quiet she has been). */
export type ReflectTrigger = { kind: ReflectKind; silentSince?: number; since?: number; dueText?: string };

function triggerText(t: ReflectTrigger, at: number): string {
  if (t.kind === "silence" && t.silentSince) {
    return `她已经 ${gapText(at - t.silentSince)} 没说话了。这是她沉默后，你心里过的一遍。`;
  }
  if (t.kind === "due") return `到时间了。她现在不在和你聊天。\n${t.dueText?.trim() || ""}`.trim();
  return "她刚说完话，你也刚回了她。";
}

/** The talk since `from`; never fewer than the usual window, so a short stretch still has its context. */
function stretchSince(rows: StoredMessage[], from: number): StoredMessage[] {
  const stretch = rows.filter((m) => m.createdAt > from);
  return stretch.length >= REFLECT_WINDOW ? stretch : rows.slice(-REFLECT_WINDOW);
}

/** Everything the mind reads, from the database. Shared with the prompt preview. */
export async function gatherReflectParts(at: number, trigger: ReflectTrigger): Promise<{
  parts: ReflectorParts;
  history: StoredMessage[];
  tz: string;
  modes: TalkModeDef[];
  current: string;
  charter: string;
}> {
  const [meta, window, charter, dossier, ident, profileData, heart, plans] = await Promise.all([
    getMeta(),
    listHistoryWindow(null, trigger.kind === "silence" ? SILENCE_WINDOW : REFLECT_WINDOW),
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
  const day = localDay(at, tz);
  const history = trigger.kind === "silence" ? stretchSince(window, Math.max(trigger.since ?? 0, dayWindow(day, tz).from)) : window;
  const [facts, days, today, current] = await Promise.all([
    timeFacts(at, tz, at + 1),
    recentDays(7, day),
    todayText(at, tz),
    effectiveMode(at, tz, ids),
  ]);
  return {
    parts: {
      charter,
      identity: identityBlock(ident.identity),
      story: profile.storyline,
      dossier,
      trigger: triggerText(trigger, at),
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

export type ReflectResult = {
  ok: boolean;
  inner: InnerState | null;
  /** Only for `due`: what he decided to send her ("" = nothing). */
  message: string;
  failKind: string | null;
  model: string;
  ms: number;
};

const kindLog = (kind: ReflectKind) => (kind === "turn" ? "reflect" : `reflect_${kind}`);

export async function runReflector(
  turnSeq: number,
  jobId?: string,
  complete: typeof callModel = callModel,
  trigger: ReflectTrigger = { kind: "turn" },
): Promise<ReflectResult> {
  const kind = trigger.kind;
  const heartBefore = await getHeart();
  if (kind === "turn" && heartBefore.turnSeq >= turnSeq) {
    return { ok: true, inner: await getInner(), message: "", failKind: null, model: "", ms: 0 };
  }

  const at = now();
  const gathered = await gatherReflectParts(at, trigger);
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
    outputRef: `inner:${kind}:${turnSeq || at}`,
    promptKey: loaded.key,
    promptHash: loaded.hash,
  });
  if (!result.ok || !result.json) {
    const failKind = classifyReflectFailure(result);
    await appendInnerLog({ turnSeq, data: { kind: kindLog(kind), error: failKind }, model: result.model, ms: result.ms });
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
    if (kind === "turn") {
      await fillReflectTurn(turnSeq, false, result.ms, failKind);
      await patchTurnTraceReflector({ turnSeq, inner: null, model: result.model, ms: result.ms });
    }
    return { ok: false, inner: null, message: "", failKind, model: result.model, ms: result.ms };
  }

  const json = result.json as Record<string, unknown>;
  const text = (key: string) => (typeof json[key] === "string" ? String(json[key]).trim() : "");
  await setHeart(text("heart") || heartBefore.text, at, kind === "turn" ? turnSeq : undefined);
  await setFocus(text("focus"));
  if (json.plans_changed === true) await replaceMindPlans(parsePlans(json.plans, tz, at), at);
  const mode = text("mode");
  if (mode && mode !== current && modes.some((m) => m.id === mode)) {
    await recordMode({ at, mode, until: null, why: kind === "turn" ? "" : kind === "silence" ? "她沉默时想的" : "到时间时想的" });
  }
  // Today's text is rewritten when a stretch of talking ends, so each stretch goes in once.
  const today = kind === "silence" ? text("today") : "";
  if (today) {
    const day = localDay(trigger.silentSince ?? at, tz);
    // A day the night pass has already closed keeps its timeline.
    if (!(await hasDay(day, dayWindow(day, tz).to))) await saveDayTimeline(day, today, at);
  }
  if (kind === "silence" && trigger.silentSince) await markSilenceSeen(trigger.silentSince);

  await appendInnerLog({ turnSeq, data: { kind: kindLog(kind), output: result.json }, model: result.model, ms: result.ms });
  const inner = await getInner();
  if (kind === "turn") {
    await fillReflectTurn(turnSeq, true, result.ms, null);
    await patchTurnTraceReflector({ turnSeq, inner, model: result.model, ms: result.ms });
  }
  return {
    ok: true,
    inner,
    message: kind === "due" ? text("message").slice(0, 2000) : "",
    failKind: null,
    model: result.model,
    ms: result.ms,
  };
}

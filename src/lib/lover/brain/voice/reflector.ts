import { QR_VOICE_READS_DIARY, REFLECT_WINDOW } from "../config.ts";
import { callModel, classifyReflectFailure } from "../llm.ts";
import { validateMind } from "../mind-parse.ts";
import {
  getMeta,
  getMind,
  getProfilePrompt,
  listFactors,
  listFindings,
  listHistoryWindow,
  listPortrait,
  listThemes,
  listThemeWeeks,
  patchBrainLog,
  saveMind,
} from "../store.ts";
import { formatClock, localDay } from "../time.ts";
import { now } from "../clock.ts";
import { fillReflectTurn } from "../observability.ts";
import { patchTurnTraceReflector } from "../turn-trace.ts";
import { isNightNoiseBody } from "../../message-markup.ts";
import { rememberBlock, rememberCharter, type ReflectRefs } from "../log-refs.ts";
import { resolveTz } from "../tz.ts";
import type { Finding, IndexItem, Mind, PortraitRow, StoredMessage, Theme } from "../types.ts";
import { EMPTY_MIND } from "../types.ts";
import { parsePromptBody, renderVariant } from "../prompts/doc.ts";
import { loadPrompt } from "../prompts/store.ts";
import {
  formatIndexLine,
  getCoreIndexItems,
  getRelatedIndexItems,
} from "./retrieve.ts";

const MIND_SCHEMA = {
  name: "mind",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["insight", "memory_ids"],
    properties: {
      insight: { type: "string" },
      memory_ids: { type: "array", items: { type: "string" } },
    },
  },
};

export { validateMind } from "../mind-parse.ts";

export function formatReflectConversation(history: StoredMessage[], timeZone: string): string {
  return history
    .filter((m) => !isNightNoiseBody(m.text))
    .map((m) => `[${formatClock(m.createdAt, timeZone)}] ${m.role === "user" ? "Rosie" : "清然"}：${m.text}`)
    .join("\n");
}

export type ReflectorParts = {
  charter: string;
  selfSummary: string;
  bondSummary: string;
  portrait: PortraitRow[];
  themes: Array<Theme & { weekHint?: string }>;
  findings: Array<{ id: string; line: string }>;
  coreIndex: IndexItem[];
  clock: string;
  relatedIndex: IndexItem[];
  oldMind: Mind;
  conversation: string;
};

export type ReflectorPacked = { system: string; stable: string; turn: string };

function findingLine(
  f: Finding,
  nameOf: (id: string) => string,
): string {
  return f.kind === "recovery"
    ? `- 「${nameOf(f.outcomeId)}」期间出现「${nameOf(f.antecedentId)}」后，常在 1–2 天内好转（${f.n11} 次）`
    : `- 「${nameOf(f.antecedentId)}」之后${f.lag ? ` ${f.lag} 天内` : "当天"}常出现「${nameOf(f.outcomeId)}」（${f.n11} 次，是平时的 ${f.lift.toFixed(1)} 倍）`;
}

/** Data only. Headings and instructions live in the reflect template. */
export function reflectVars(parts: ReflectorParts): Record<string, string> {
  const portrait = parts.portrait
    .filter((p) => p.status === "active")
    .slice()
    .sort((a, b) => a.topic.localeCompare(b.topic) || a.id.localeCompare(b.id));
  const themes = parts.themes.slice().sort((a, b) => a.id.localeCompare(b.id));
  const findings = parts.findings.slice().sort((a, b) => a.id.localeCompare(b.id));
  const core = parts.coreIndex.slice().sort((a, b) => a.id.localeCompare(b.id));
  return {
    system_prompt: parts.charter,
    self: parts.selfSummary.trim() || "（还没有）",
    bond: parts.bondSummary.trim() || "（还没有）",
    portrait: portrait.map((p) => `${p.topic}：${p.body}`).join("\n") || "（还在认识她）",
    themes: themes.length
      ? themes.map((t) => `- ${t.name}：${t.definition}（${t.weekHint ?? "尚无周统计"}）`).join("\n")
      : "（还没有）",
    findings: findings.length ? findings.map((f) => f.line).join("\n") : "（还没有）",
    index_core: core.map(formatIndexLine).join("\n") || "（还没有）",
    clock: parts.clock,
    index_related: parts.relatedIndex.map(formatIndexLine).join("\n") || "（还没有）",
    old_mind: parts.oldMind.insight.trim() || "（空）",
    conversation: parts.conversation.trim() || "（还没有）",
  };
}

/** A = system（几乎不变），B = 第一段 user（日/记忆库变），C = 其余 user（每轮变）。文字全部来自模板。 */
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

export async function runReflector(turnSeq: number, jobId?: string): Promise<Mind | null> {
  const old = await getMind();
  if (old.turn_seq >= turnSeq) return old;

  const [meta, history, portrait, systemPrompt] = await Promise.all([
    getMeta(),
    listHistoryWindow(null, REFLECT_WINDOW),
    listPortrait(),
    getProfilePrompt(),
  ]);

  const tz = resolveTz(meta.timeZone);
  const day = localDay(now(), tz);
  const coreIndex = await getCoreIndexItems(day);
  const coreIds = new Set(coreIndex.map((i) => i.id));
  const rosieLast = history
    .filter((m) => m.role === "user" && !isNightNoiseBody(m.text))
    .slice(-4)
    .map((m) => m.text);
  const query = [...rosieLast, old.insight].filter(Boolean).join("\n");
  const relatedIndex = await getRelatedIndexItems(query, coreIds);

  const themesPacked: ReflectorParts["themes"] = [];
  const findingsPacked: ReflectorParts["findings"] = [];
  if (QR_VOICE_READS_DIARY) {
    const [themes, findings, weeks, factors] = await Promise.all([
      listThemes(true),
      listFindings(),
      listThemeWeeks(),
      listFactors(false),
    ]);
    const factorName = new Map(factors.map((f) => [f.id, f.name]));
    const nameOf = (id: string) => factorName.get(id) ?? id;
    const weekMap = new Map<string, string>();
    for (const w of weeks.slice().sort((a, b) => b.week.localeCompare(a.week))) {
      if (!weekMap.has(w.themeId)) {
        weekMap.set(w.themeId, `${w.week} 提到 ${w.mentions} 次`);
      }
    }
    for (const t of themes
      .filter((x) => x.userFeedback !== "rejected")
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 8)) {
      themesPacked.push({ ...t, weekHint: weekMap.get(t.id) });
    }
    for (const f of findings
      .filter((x) => x.userFeedback !== "rejected" && x.kind !== "cooccur" && x.tier === "finding")
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 5)) {
      findingsPacked.push({ id: f.id, line: findingLine(f, nameOf) });
    }
  }

  const convo = formatReflectConversation(history, tz);
  const clockText = formatClock(now(), tz);

  const loaded = await loadPrompt("reflect");
  const packed = buildReflectorInput(
    {
      charter: systemPrompt,
      selfSummary: meta.selfSummary,
      bondSummary: meta.bondSummary,
      portrait,
      themes: themesPacked,
      findings: findingsPacked,
      coreIndex,
      clock: clockText,
      relatedIndex,
      oldMind: old,
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
    relatedIds: relatedIndex.map((i) => i.id),
    oldMindTurnSeq: old.turn_seq,
    recentMessageIds: history.map((m) => m.id),
    clockText,
    timeZone: tz,
  };

  const result = await callModel("reflect", {
    system: packed.system,
    input: packed.stable,
    inputParts: [packed.stable, packed.turn],
    schema: MIND_SCHEMA,
    jobId,
    turnSeq,
    refs,
    outputRef: `mind:${turnSeq}`,
    promptKey: loaded.key,
    promptHash: loaded.hash,
  });
  if (!result.ok || !result.json) {
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
    await fillReflectTurn(turnSeq, false, result.ms, classifyReflectFailure(result));
    await patchTurnTraceReflector({ turnSeq, mind: null, model: result.model, ms: result.ms });
    return null;
  }
  const allowed = new Set([...coreIndex, ...relatedIndex].map((i) => i.id));
  const next = validateMind(result.json, old, allowed);
  next.turn_seq = turnSeq;
  const saved = await saveMind(next, turnSeq, { model: result.model, ms: result.ms });
  if (!saved) {
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
  }
  await fillReflectTurn(turnSeq, saved, result.ms, saved ? null : "stale");
  await patchTurnTraceReflector({
    turnSeq,
    mind: saved ? next : null,
    model: result.model,
    ms: result.ms,
  });
  return saved ? next : old;
}

export { EMPTY_MIND };

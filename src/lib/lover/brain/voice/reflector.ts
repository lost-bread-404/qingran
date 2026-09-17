import { QR_VOICE_READS_DIARY, REFLECT_WINDOW } from "../config.ts";
import { callModel } from "../llm.ts";
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
import { rememberBlock, rememberCharter, type ReflectRefs } from "../log-refs.ts";
import { resolveTz } from "../tz.ts";
import type { Finding, IndexItem, Mind, PortraitRow, StoredMessage, Theme } from "../types.ts";
import { EMPTY_MIND } from "../types.ts";
import { REFLECTOR_SYSTEM } from "./prompts.ts";
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
    required: [
      "rosie_now",
      "undercurrent",
      "reading",
      "soft_spot",
      "my_feel",
      "my_view",
      "my_logic",
      "lead_plan",
      "intent",
      "threads",
      "memory_ids",
    ],
    properties: {
      rosie_now: { type: "string" },
      undercurrent: { type: "string" },
      reading: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["guess", "conf"],
          properties: {
            guess: { type: "string" },
            conf: { type: "number" },
          },
        },
      },
      soft_spot: { type: "string" },
      my_feel: { type: "string" },
      my_view: { type: "string" },
      my_logic: { type: "string" },
      lead_plan: { type: "array", items: { type: "string" } },
      intent: { type: "string" },
      threads: { type: "array", items: { type: "string" } },
      memory_ids: { type: "array", items: { type: "string" } },
    },
  },
};

export { validateMind } from "../mind-parse.ts";

export function formatReflectConversation(history: StoredMessage[], timeZone: string): string {
  return history
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

/** A = system（几乎不变），B = 第一段 user（日/记忆库变），C = 第二段 user（每轮变）。 */
export function buildReflectorInput(parts: ReflectorParts): ReflectorPacked {
  const portrait = parts.portrait
    .filter((p) => p.status === "active")
    .slice()
    .sort((a, b) => a.topic.localeCompare(b.topic) || a.id.localeCompare(b.id));
  const themes = parts.themes.slice().sort((a, b) => a.id.localeCompare(b.id));
  const findings = parts.findings.slice().sort((a, b) => a.id.localeCompare(b.id));
  const core = parts.coreIndex.slice().sort((a, b) => a.id.localeCompare(b.id));

  const system = `${REFLECTOR_SYSTEM}

【人设】
${parts.charter}`;

  let stable = `【我自己】
${parts.selfSummary || "（还没有）"}

【我们】
${parts.bondSummary || "（还没有）"}

【我眼中的她】
${portrait.map((p) => `${p.topic}：${p.body}`).join("\n") || "（还在认识她）"}
`;
  if (themes.length) {
    stable +=
      "\n【她的长期规律·主题】\n" +
      themes.map((t) => `- ${t.name}：${t.definition}（${t.weekHint ?? "尚无周统计"}）`).join("\n") +
      "\n";
  }
  if (findings.length) {
    stable += "\n【她的长期规律·发现】\n" + findings.map((f) => f.line).join("\n") + "\n";
  }
  stable += `\n【记忆 index · 核心】
${core.map(formatIndexLine).join("\n") || "（还没有）"}`;

  const turn = `现在是${parts.clock}。

【记忆 index · 相关】
${parts.relatedIndex.map(formatIndexLine).join("\n") || "（还没有）"}

【上一刻的内心】
${JSON.stringify(parts.oldMind, (k, v) => (k === "turn_seq" || k === "updated_at" ? undefined : v))}

【最近对话】
${parts.conversation || "（还没有）"}

请按 schema 输出内心。不要输出 recent_intents 和 turn_seq。从【记忆 index · 核心】和【记忆 index · 相关】中挑选 memory_ids，最多 6 个。`;

  return { system, stable, turn };
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
    .filter((m) => m.role === "user")
    .slice(-4)
    .map((m) => m.text);
  const query = [...rosieLast, ...(old.threads ?? []), ...(old.lead_plan ?? [])].filter(Boolean).join("\n");
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

  const packed = buildReflectorInput({
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
  });

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
  });
  if (!result.ok || !result.json) {
    await patchBrainLog(result.logId, { outputText: result.text || null, outputRef: null });
    await fillReflectTurn(turnSeq, false, result.ms, "timeout-or-parse");
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
  return saved ? next : old;
}

export { EMPTY_MIND };

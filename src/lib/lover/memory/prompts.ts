import type { ChatMessage } from "../types.ts";
import type {
  DecisionA,
  L2Draft,
  L3Pattern,
  L2Event,
  OpenEvent,
  PatternDraft,
  Retrievable,
} from "./types.ts";

export const PROMPT_A_SYSTEM = `你在给一段长期对话做事件归档。不扮演任何人，不回复 Rosie。

对照「当前未完成事件」和「刚滑出近窗的对话」，三选一：
- merge：还是同一件事，更新草稿
- close_and_open：上一件已经能完整叙述，新对话是另一件事。把上一件收成以后能检索到的记录，并给新事件一份草稿
- ignore：闲聊、重复、没有跨会话价值

结束与否只看内容有没有换页。跨夜、隔很多天、第二天接着聊，都可以仍是同一件。没结束就不要写成已经有结果。

写事件时要具体、可检索：人名、关系、决定、身体、时间感、为什么这件事还记得。让以后只看到这一条的人能接上。有洞察就写，没把握的细节不要编。

只输出一个 JSON 对象。`;

export const PROMPT_B_SYSTEM = `你在把本周期已经结束的小事件，收成更少、更高分辨率的叙述。

同一条故事线并在一起；无关的事分开。原料里有的因由、转折、结果都保留。让以后检索到这一条时，能理解它为什么重要。

不要编造。不要写清然该怎样。规律和画像留给下一步。

只输出一个 JSON 对象。`;

export const PROMPT_C_SYSTEM = `你在维护一份会随时间改写的用户状态。不扮演清然，也不改清然的人设。

两件事：

1. 规律
什么结构在这个人身上反复出现。写现象，写清楚，可以有判断。
- active：眼下仍在起作用，或本周期又出现了证据
- dormant：这是真的、曾经或周期性出现，但此刻不在场面上
有新证据就 active；证据回撤就 dormant。不要删事实。不要用诊断标签。

2. 活画像
整页重写。写这个人最近是什么样、和人怎样靠近、眼下悬着什么。有洞察，但每句都要站得住。单次情绪不要升成性格。未结束的事最多点一下「还在进行」，不要替它收尾。不要宣读记忆清单。篇幅紧凑，大约一篇短文。

只输出一个 JSON 对象。`;

export const PROMPT_D_SYSTEM = `你是记忆挑选器。从候选里为当前对话选出此刻值得带上的记忆，最多16条。
优先：此刻仍成立的近况；与当前话题直接相关的事或人名；仍有效或虽休眠但正好被当前话题唤起的规律。
不要选已结束且与当前话题无关的旧细节。
宁少勿滥也可以，但相关的不要漏。只输出 JSON。`;

export function buildPromptAUser(opts: {
  open: OpenEvent | null;
  dropped: ChatMessage[];
  clock: (ms: number) => string;
}): string {
  const openBlock = opts.open
    ? `开始时间：${opts.clock(opts.open.startedAt)}
草稿：${opts.open.draft || "（空）"}
已收录要点：
${opts.open.points || "（无）"}`
    : `开始时间：（无）
草稿：（无）
已收录要点：
（无）`;

  return `【当前未完成事件】
${openBlock}

【新挤出的对话】
${formatDropped(opts.dropped, opts.clock)}

请输出 JSON：
{"decision":"merge|close_and_open|ignore","closed_event":"","closed_start":"","closed_end":"","open_draft":"","open_start":"","note":""}`;
}

export function buildPromptBUser(opts: {
  periodStart: string;
  periodEnd: string;
  l1: Array<{ startedAt: number; endedAt: number; text: string }>;
  clock: (ms: number) => string;
}): string {
  const list =
    opts.l1.length === 0
      ? "（无）"
      : opts.l1
          .map(
            (item, i) =>
              `${i + 1}. ${opts.clock(item.startedAt)} 至 ${opts.clock(item.endedAt)}：${item.text}`,
          )
          .join("\n");
  return `本周期：${opts.periodStart} 至 ${opts.periodEnd}

【本周期新入库的小事件 L1】
${list}

请输出 JSON：
{"l2":[{"time":"时间范围","text":"高维叙述"}]}
若没有可收束的，输出 {"l2":[]}`;
}

export function buildPromptCUser(opts: {
  periodStart: string;
  periodEnd: string;
  newL2: L2Draft[];
  oldL2: L2Event[];
  oldL3: L3Pattern[];
  portrait: string;
  openDraft: string;
  now: number;
  clock: (ms: number) => string;
}): string {
  const newL2 =
    opts.newL2.length === 0
      ? "（无）"
      : opts.newL2.map((item) => `- ${item.time}：${item.text}`).join("\n");
  const old = [
    ...opts.oldL2.map(
      (item) =>
        `- L2 ${opts.clock(item.periodStart)}–${opts.clock(item.periodEnd)}：${item.text}`,
    ),
    ...opts.oldL3.map((item) => {
      const days = Math.max(0, Math.round((opts.now - item.lastEvidenceAt) / 86_400_000));
      return `- L3 status=${item.status} last=${opts.clock(item.lastEvidenceAt)} (${days}天前)：${item.text}`;
    }),
  ];
  return `本周期：${opts.periodStart} 至 ${opts.periodEnd}

【本周期新 L2】
${newL2}

【近期旧 L2 / 旧 L3】
${old.length ? old.join("\n") : "（无）"}

【当前活画像】
${opts.portrait.trim() || "（无）"}

【未完成事件（若有，仅供一句现场，不要当结论）】
${opts.openDraft.trim() || "（无）"}

请输出 JSON：
{"patterns":[{"status":"active|dormant","time":"","text":""}],"portrait":"整篇新画像"}`;
}

export function buildPromptDUser(opts: {
  brief: string;
  candidates: Retrievable[];
  clock: (ms: number) => string;
}): string {
  const list = opts.candidates
    .map(
      (item) =>
        `- id=${item.id} layer=${item.layer} status=${item.status} time=${opts.clock(item.startedAt)}：${item.text}`,
    )
    .join("\n");
  return `【当前用户最后一句话与近上下文要点】
${opts.brief}

【候选记忆】
${list}

请输出 JSON：
{"ids":["选中的id"]}`;
}

export function formatDropped(messages: ChatMessage[], clock: (ms: number) => string): string {
  return messages
    .map((m) => {
      const who = m.role === "user" ? "Rosie" : "清然";
      return `${who}（${clock(m.createdAt)}）：${m.text}`;
    })
    .join("\n")
    .slice(0, 6000);
}

export function parseDecisionA(raw: string): DecisionA | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return parseDecisionAText(raw);
  const row = parsed as Record<string, unknown>;
  const decision = String(row.decision ?? "").trim();
  if (decision !== "merge" && decision !== "close_and_open" && decision !== "ignore") {
    return parseDecisionAText(raw);
  }
  return {
    decision,
    closedEvent: str(row.closed_event ?? row.closedEvent),
    closedStart: str(row.closed_start ?? row.closedStart),
    closedEnd: str(row.closed_end ?? row.closedEnd),
    openDraft: str(row.open_draft ?? row.openDraft),
    openStart: str(row.open_start ?? row.openStart),
    note: str(row.note).slice(0, 80),
  };
}

export function parseL2List(raw: string): L2Draft[] | null {
  const trimmed = raw.trim();
  if (/L2:\s*none/i.test(trimmed)) return [];
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as { l2?: unknown };
  if (!Array.isArray(row.l2)) return [];
  return row.l2
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const rec = item as { time?: unknown; text?: unknown };
      const text = str(rec.text);
      if (!text) return null;
      return { time: str(rec.time) || "本周期", text };
    })
    .filter((item): item is L2Draft => Boolean(item))
    .slice(0, 12);
}

export function parsePatternsAndPortrait(
  raw: string,
): { patterns: PatternDraft[]; portrait: string } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return parsePatternsText(raw);
  const row = parsed as { patterns?: unknown; portrait?: unknown };
  const portrait = str(row.portrait);
  const patterns = Array.isArray(row.patterns)
    ? row.patterns
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const rec = item as { status?: unknown; time?: unknown; text?: unknown };
          const status = str(rec.status) === "dormant" ? "dormant" : "active";
          const text = str(rec.text);
          if (!text) return null;
          return { status, time: str(rec.time), text } satisfies PatternDraft;
        })
        .filter((item): item is PatternDraft => Boolean(item))
        .slice(0, 24)
    : [];
  return { patterns, portrait };
}

export function parsePickedIds(raw: string, allowed: string[]): string[] {
  const parsed = parseJson(raw);
  const allowedSet = new Set(allowed);
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { ids?: unknown }).ids)) {
    return (parsed as { ids: unknown[] }).ids
      .map((id) => String(id))
      .filter((id) => allowedSet.has(id))
      .slice(0, 16);
  }
  const found: string[] = [];
  for (const id of allowed) {
    if (raw.includes(id)) found.push(id);
  }
  return found.slice(0, 16);
}

function parseDecisionAText(raw: string): DecisionA | null {
  const decision = raw.match(/decision:\s*(merge|close_and_open|ignore)/i)?.[1]?.toLowerCase();
  if (decision !== "merge" && decision !== "close_and_open" && decision !== "ignore") {
    return null;
  }
  return {
    decision,
    closedEvent: field(raw, "closed_event"),
    closedStart: field(raw, "closed_start"),
    closedEnd: field(raw, "closed_end"),
    openDraft: field(raw, "open_draft"),
    openStart: field(raw, "open_start"),
    note: field(raw, "note").slice(0, 80),
  };
}

function parsePatternsText(
  raw: string,
): { patterns: PatternDraft[]; portrait: string } | null {
  const portraitIdx = raw.search(/PORTRAIT\s*:/i);
  if (portraitIdx < 0) return null;
  const head = raw.slice(0, portraitIdx);
  const portrait = raw.slice(portraitIdx).replace(/^PORTRAIT\s*:/i, "").trim();
  const patterns: PatternDraft[] = [];
  for (const line of head.split("\n")) {
    const m = line.match(/status\s*=\s*(active|dormant)\s*\|\s*([^|]*)\|\s*(.+)/i);
    if (!m) continue;
    const text = m[3]!.trim();
    if (!text) continue;
    patterns.push({
      status: m[1]!.toLowerCase() === "dormant" ? "dormant" : "active",
      time: m[2]!.trim(),
      text,
    });
  }
  return { patterns, portrait };
}

function field(raw: string, key: string): string {
  const m = raw.match(new RegExp(`${key}\\s*:\\s*(.*)`, "i"));
  return (m?.[1] ?? "").trim();
}

function str(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function parseJson(raw: string): unknown {
  const trimmed = extractJson(raw);
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1]!.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export function parseMaybeTime(raw: string, fallback: number): number {
  const s = raw.trim();
  if (!s) return fallback;
  const n = Number(s);
  if (Number.isFinite(n) && n > 1e12) return n;
  if (Number.isFinite(n) && n > 1e9 && n < 1e12) return Math.floor(n * 1000);
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return parsed;
  return fallback;
}

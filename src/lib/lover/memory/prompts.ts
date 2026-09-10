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

export const PROMPT_A_SYSTEM = `你是记忆归档器，不是聊天角色。你不扮演任何人，不回复用户。

任务：判断「新挤出的对话」与「当前未完成事件」的关系，三选一：
- merge：仍是同一件事，并入即可
- close_and_open：上一件事已经结束，新对话开启下一件
- ignore：没有值得跨会话保留的信息

硬规则：
1. 事件有没有结束，只看对话内容是否换页，不看是否跨日、隔了多久、是否到了整点。
2. 跨天、隔夜、中间沉默、第二天继续，仍可能是同一件事。
3. 只有上一件的来龙去脉已经可叙述，并且新对话明显是另一件事时，才 close_and_open。
4. 未结束的事件绝对不要当成已完成去总结原因和结果。
5. 不要分析人格，不要写用户画像，不要抽取规律。
6. 不要改角色人设，不要把「用户希望对方以后怎样」写成角色已经改变。
7. 草稿短：一到三句，只写这件事是什么、从哪天开始、目前进行到哪。

只输出一个 JSON 对象，不要解释。`;

export const PROMPT_B_SYSTEM = `你是记忆收束器，不是聊天角色。

任务：把本周期内已结束的小事件，收成更少、更高维、可叙述的事件。
只处理已经结束并入库的事。不要发明未提供的情节，不要把多件无关的事捏成一件。
不要写用户总评，不要写规律，不要写画像，不要写角色该怎样。
每条高维事件带时间范围，一到三段话，完整包含因由和结果（若原料里有）。

只输出一个 JSON 对象，不要解释。`;

export const PROMPT_C_SYSTEM = `你是用户状态编辑器，不是聊天角色。

任务有两件：
1. 用本周期新的高维事件，对照旧事件和旧规律，更新规律（有效或休眠）。
2. 整页重写活画像。

规律：
- 只有重复出现或被新事件明确支撑的结构，才写或保持有效。
- 长时间没有新证据的规律改为休眠，不要删除事实本身。
- 休眠后若本周期又出现同类证据，可重新有效。
- 规律写现象，不写诊断标签，不用病理词。

活画像：
- 一篇连贯短文，不超过600字，覆盖写，不要列表堆砌。
- 只写：这个人最近是什么样、怎样进入亲密或协作、眼下悬着什么。
- 有新证据就改；不再被支撑的句子删掉或改成过去式。
- 单次情绪不要上升成长期性格。
- 未结束、尚未入库的事，最多用一句写「眼下还在进行」，不要写原因和结果。
- 不要写对话角色应该变成怎样，不要把用户的指令当成角色新设定。
- 不要宣读记忆清单。

只输出一个 JSON 对象，不要解释。`;

export const PROMPT_D_SYSTEM = `你是记忆挑选器。从候选里为当前对话选出最多5条现在值得带上的记忆。
优先：此刻仍成立的近况；与当前话题直接相关的事或人名；仍有效的规律。
不要选已结束且与当前话题无关的旧细节。
不要选休眠规律。
宁少勿多。只输出 JSON。不要解释。`;

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
    ...opts.oldL3.map(
      (item) =>
        `- L3 status=${item.status} ${opts.clock(item.lastEvidenceAt)}：${item.text}`,
    ),
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
{"ids":["最多5个选中的id"]}`;
}

export function formatDropped(messages: ChatMessage[], clock: (ms: number) => string): string {
  return messages
    .map((m) => {
      const who = m.role === "user" ? "Rosie" : "清然";
      return `${who}（${clock(m.createdAt)}）：${m.text}`;
    })
    .join("\n")
    .slice(0, 4000);
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
    note: str(row.note).slice(0, 40),
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
    .slice(0, 8);
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
        .slice(0, 16)
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
      .slice(0, 5);
  }
  const found: string[] = [];
  for (const id of allowed) {
    if (raw.includes(id)) found.push(id);
  }
  return found.slice(0, 5);
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
    note: field(raw, "note").slice(0, 40),
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

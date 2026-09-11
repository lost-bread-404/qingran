import type { ChatMessage } from "../types.ts";
import type {
  ArchiveA,
  L2Draft,
  L3Pattern,
  L2Event,
  OpenEvent,
  PatternDraft,
  Retrievable,
} from "./types.ts";

export const PROMPT_A_SYSTEM = `从刚挤出近窗的对话里决定记什么。你输出的内容会原样入库。

未完成的事可以同时有几件，每一件一句。日常撒娇、喵喵、嗯嗯也记，收成高维的一句，比如「Rosie在对清然撒娇」。原话细节不誊进去。

大事件没结束时，中间冒出以后还用得上的要点，另写成 facts，带时间：哪里不舒服、谁进场离场、一个决定。那不是噪音。

主要记 Rosie 说的话和发生在她身上的事。

输出当前全部未完成（整表替换），以及本轮新写入的 facts。一件事结束了就从 open 拿掉，放进 facts。`;

export const PROMPT_B_SYSTEM = `把本周期新的小事件收成更大的事件。同一条故事线用已有 id 更新，不要另写一条。

例：几天前 Rosie 长了溃疡，今天好了 → 更新成「某日到某日，Rosie长了溃疡，中间若有别的溃疡信息也写上，Rosie溃疡好了」。`;

export const PROMPT_C_SYSTEM = `维护会随时间改写的用户状态。

规律：每个主题一条，用已有 id 更新。关于溃疡的内容永远只占一条。
- active：眼下仍在起作用，或本周期又有证据
- dormant：是真的，但此刻不在场面上

活画像：清然眼中的 Rosie。她最近是什么样、和人怎样靠近、眼下悬着什么。可以写她对清然的信任和依赖，不写清然做了什么。`;

export const PROMPT_D_SYSTEM = `从候选里为当前这句话挑相关记忆，最多8条。没有明确话题时，优先未完成的事。只输出选中的 id。`;

export function buildPromptAUser(opts: {
  open: OpenEvent[];
  dropped: ChatMessage[];
  clock: (ms: number) => string;
}): string {
  const openBlock =
    opts.open.length === 0
      ? "（无）"
      : opts.open
          .map((item) => `- id=${item.id} 开始${opts.clock(item.startedAt)}：${item.text}`)
          .join("\n");
  return `【当前未完成】
${openBlock}

【新挤出的对话】
${formatDropped(opts.dropped, opts.clock)}

请输出 JSON：
{"open":[{"id":"已有id或空","text":"一句高维的未完成","started":""}],"facts":[{"text":"Rosie今天溃疡好了","time":""}]}`;
}

export function buildPromptBUser(opts: {
  periodStart: string;
  periodEnd: string;
  l1: Array<{ startedAt: number; endedAt: number; text: string }>;
  oldL2: L2Event[];
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
  const old =
    opts.oldL2.length === 0
      ? "（无）"
      : opts.oldL2
          .map((item) => `- id=${item.id} ${opts.clock(item.periodStart)}–${opts.clock(item.periodEnd)}：${item.text}`)
          .join("\n");
  return `本周期：${opts.periodStart} 至 ${opts.periodEnd}

【本周期新 L1】
${list}

【已有 L2，同一故事线请用 id 更新】
${old}

请输出 JSON：
{"arcs":[{"id":"已有id或空","time":"时间范围","text":"一句或一小段"}]}`;
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
  const oldL2 = opts.oldL2
    .map((item) => `- L2 id=${item.id} ${opts.clock(item.periodStart)}–${opts.clock(item.periodEnd)}：${item.text}`)
    .join("\n");
  const oldL3 = opts.oldL3
    .map((item) => {
      const days = Math.max(0, Math.round((opts.now - item.lastEvidenceAt) / 86_400_000));
      return `- id=${item.id} status=${item.status} last=${opts.clock(item.lastEvidenceAt)} (${days}天前)：${item.text}`;
    })
    .join("\n");
  return `本周期：${opts.periodStart} 至 ${opts.periodEnd}

【本周期新/更新的 L2】
${newL2}

【近期 L2】
${oldL2 || "（无）"}

【已有规律，同一主题请用 id 更新】
${oldL3 || "（无）"}

【当前活画像】
${opts.portrait.trim() || "（无）"}

【未完成】
${opts.openDraft.trim() || "（无）"}

请输出 JSON：
{"patterns":[{"id":"已有id或空","status":"active|dormant","time":"","text":""}],"portrait":"清然眼中的 Rosie"}`;
}

export function buildPromptDUser(opts: {
  brief: string;
  candidates: Retrievable[];
  clock: (ms: number) => string;
}): string {
  const list = opts.candidates
    .map((item) => {
      const tag = item.layer === "open" ? "未完成" : item.layer;
      return `- id=${item.id} ${tag} ${opts.clock(item.startedAt)}：${item.text}`;
    })
    .join("\n");
  return `【当前用户这句话】
${opts.brief}

【候选】
${list || "（无）"}

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

export function parseArchiveA(raw: string): ArchiveA | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as { open?: unknown; facts?: unknown };
  const open = Array.isArray(row.open)
    ? row.open
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const rec = item as { id?: unknown; text?: unknown; started?: unknown };
          const text = str(rec.text);
          if (!text) return null;
          return { id: str(rec.id), text, started: str(rec.started) };
        })
        .filter((item): item is { id: string; text: string; started: string } => Boolean(item))
        .slice(0, 12)
    : [];
  return { open, facts: parseFacts(row.facts) };
}

export function parseL2List(raw: string): L2Draft[] | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as { arcs?: unknown; l2?: unknown };
  const list = Array.isArray(row.arcs) ? row.arcs : Array.isArray(row.l2) ? row.l2 : null;
  if (!list) return [];
  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const rec = item as { id?: unknown; time?: unknown; text?: unknown };
      const text = str(rec.text);
      if (!text) return null;
      return { id: str(rec.id), time: str(rec.time) || "本周期", text };
    })
    .filter((item): item is L2Draft => Boolean(item))
    .slice(0, 12);
}

export function parsePatternsAndPortrait(
  raw: string,
): { patterns: PatternDraft[]; portrait: string } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as { patterns?: unknown; portrait?: unknown };
  const portrait = str(row.portrait);
  const patterns = Array.isArray(row.patterns)
    ? row.patterns
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const rec = item as { id?: unknown; status?: unknown; time?: unknown; text?: unknown };
          const text = str(rec.text);
          if (!text) return null;
          return {
            id: str(rec.id),
            status: str(rec.status) === "dormant" ? "dormant" : "active",
            time: str(rec.time),
            text,
          } satisfies PatternDraft;
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
      .slice(0, 8);
  }
  const found: string[] = [];
  for (const id of allowed) {
    if (raw.includes(id)) found.push(id);
  }
  return found.slice(0, 8);
}

function parseFacts(value: unknown): Array<{ text: string; time: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") {
        const text = str(item);
        return text ? { text, time: "" } : null;
      }
      if (!item || typeof item !== "object") return null;
      const rec = item as { text?: unknown; time?: unknown };
      const text = str(rec.text);
      if (!text) return null;
      return { text, time: str(rec.time) };
    })
    .filter((item): item is { text: string; time: string } => Boolean(item))
    .slice(0, 8);
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

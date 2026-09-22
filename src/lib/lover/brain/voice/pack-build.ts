import { HISTORY_WINDOW, PORTRAIT_MAX_CHARS, SESSION_GAP_MS } from "../config.ts";
import { defaultPrompt } from "../prompts/catalog.ts";
import { fillTemplate, templateHas } from "../prompts/fill.ts";
import { formatClock } from "../time.ts";
import type { Mind, Note, PortraitRow, StoredMessage, VoiceChatMessage } from "../types.ts";
import { EMPTY_MIND } from "../types.ts";
import { modelFacingText } from "../../message-markup.ts";

function mindIsEmpty(mind: Mind): boolean {
  return !mind.insight.trim();
}

function portraitBlock(rows: PortraitRow[]): string {
  const active = rows.filter((r) => r.status === "active");
  if (!active.length) return "（还在慢慢认识她）";
  const lines = active.map((r) => `${r.topic}：${r.body}`);
  let text = lines.join("\n");
  if (text.length > PORTRAIT_MAX_CHARS) text = `${text.slice(0, PORTRAIT_MAX_CHARS - 1)}…`;
  return text;
}

export function renderVoiceLongterm(selfSummary: string, bondSummary: string, portrait: PortraitRow[]): string {
  return `【我自己】${selfSummary || "（还在过自己的日子）"}
【我们】${bondSummary || "（还在一点点建立）"}
【我眼中的她】${portraitBlock(portrait)}`;
}

function formatMemories(notes: Note[], timeZone: string): string {
  if (!notes.length) return "（这一刻没有特别要提起的）";
  return notes
    .map((n) => {
      const md = n.localDay.slice(5) || formatClock(n.happenedAt, timeZone).slice(0, 10);
      return `${md} ${n.text}`;
    })
    .join("\n");
}

export const VOICE_THIN_HISTORY = 8;
export type VoiceStrip = "none" | "mind" | "notes" | "thin";
export const VOICE_STRIPS: VoiceStrip[] = ["none", "mind", "notes", "thin"];

export type VoicePackParts = {
  charter: string;
  longterm: string;
  history: StoredMessage[];
  userText: string;
  mind: Mind;
  notes: Note[];
  clockText: string;
  timeZone: string;
  careHint: boolean;
  nowMs: number;
  mindStale: boolean;
  jump: boolean;
  voiceTemplate?: string;
  selfSummary?: string;
  bondSummary?: string;
  portrait?: PortraitRow[];
};

export type VoiceInputChars = {
  system: number;
  mind: number;
  notes: number;
  history: number;
  user: number;
};

const FALLBACK_CHARTER = "你就是清然。正在和 Rosie 语音通话。";

export function systemCharter(charter: string, template = defaultPrompt("voice")): string {
  return fillTemplate(template, {
    system_prompt: charter.trim() || FALLBACK_CHARTER,
  }).trim();
}

function historyText(history: StoredMessage[]): string {
  return history
    .map((m) => `${m.role === "user" ? "Rosie" : "清然"}：${modelFacingText(m.text)}`)
    .join("\n");
}

function voiceVars(parts: VoicePackParts, tail: string): Record<string, string> {
  const portrait = parts.portrait ? portraitBlock(parts.portrait) : "";
  return {
    system_prompt: parts.charter.trim() || FALLBACK_CHARTER,
    self: parts.selfSummary ?? "",
    bond: parts.bondSummary ?? "",
    portrait,
    memories: formatMemories(parts.notes, parts.timeZone),
    history: historyText(parts.history),
    clock: parts.clockText,
    mind: mindIsEmpty(parts.mind) ? "" : parts.mind.insight.trim(),
    tail,
  };
}

export function voiceMessagesForStrip(parts: VoicePackParts, strip: VoiceStrip): VoiceChatMessage[] {
  const template = parts.voiceTemplate ?? defaultPrompt("voice");
  if (strip === "thin") {
    const history = parts.history.slice(-VOICE_THIN_HISTORY).map((m) => ({
      role: m.role as "user" | "assistant",
      content: modelFacingText(m.text),
    }));
    return [
      { role: "system", content: systemCharter(parts.charter, template) },
      ...history,
      { role: "user", content: parts.userText },
    ];
  }
  const mind = strip === "none" ? parts.mind : EMPTY_MIND;
  const notes = strip === "none" || strip === "mind" ? parts.notes : [];
  const tail = buildTail({
    clock: parts.clockText,
    mind,
    notes,
    timeZone: parts.timeZone,
    careHint: parts.careHint,
    nowMs: parts.nowMs,
    stale: parts.mindStale && Boolean(parts.mind.updated_at) && parts.mind.turn_seq > 0,
    jump: parts.jump,
  });
  return buildVoiceMessages({
    charter: parts.charter,
    longterm: parts.longterm,
    history: parts.history,
    tail,
    userText: parts.userText,
    voiceTemplate: template,
    vars: voiceVars({ ...parts, mind, notes }, tail),
  });
}

export function voiceInputChars(parts: VoicePackParts): VoiceInputChars {
  const template = parts.voiceTemplate ?? defaultPrompt("voice");
  const system = systemCharter(parts.charter, template).length;
  const tailMind = buildTail({
    clock: parts.clockText,
    mind: parts.mind,
    notes: [],
    timeZone: parts.timeZone,
    careHint: false,
    nowMs: parts.nowMs,
    stale: parts.mindStale,
    jump: parts.jump,
  });
  const tailBare = buildTail({
    clock: parts.clockText,
    mind: EMPTY_MIND,
    notes: [],
    timeZone: parts.timeZone,
    careHint: false,
    nowMs: parts.nowMs,
    stale: false,
    jump: false,
  });
  const tailNotes = buildTail({
    clock: parts.clockText,
    mind: EMPTY_MIND,
    notes: parts.notes,
    timeZone: parts.timeZone,
    careHint: false,
    nowMs: parts.nowMs,
    stale: false,
    jump: false,
  });
  return {
    system,
    mind: Math.max(0, tailMind.length - tailBare.length),
    notes: Math.max(0, tailNotes.length - tailBare.length),
    history: parts.history.reduce((n, m) => n + modelFacingText(m.text).length, 0),
    user: parts.userText.length,
  };
}

export function formatVoiceInputCharsLine(c: VoiceInputChars): string {
  return `chars system=${c.system} mind=${c.mind} notes=${c.notes} history=${c.history} user=${c.user}`;
}

export function parseVoiceInputCharsLine(note: string | null | undefined): VoiceInputChars | null {
  const m = (note ?? "").match(/chars system=(\d+) mind=(\d+) notes=(\d+) history=(\d+) user=(\d+)/);
  if (!m) return null;
  return {
    system: Number(m[1]),
    mind: Number(m[2]),
    notes: Number(m[3]),
    history: Number(m[4]),
    user: Number(m[5]),
  };
}

export function stripLabel(strip: VoiceStrip): string {
  if (strip === "mind") return "去掉了 mind";
  if (strip === "notes") return "去掉了 mind 和记忆笔记";
  if (strip === "thin") return "只保留 system prompt、最近 8 条对话和用户消息";
  return "未裁剪";
}

export function buildTail(opts: {
  clock: string;
  mind: Mind;
  notes: Note[];
  timeZone: string;
  careHint: boolean;
  nowMs?: number;
  stale?: boolean;
  jump?: boolean;
}): string {
  const mindAge = (opts.nowMs ?? 0) - (opts.mind.updated_at ?? 0);
  const stale =
    opts.stale ??
    (!mindIsEmpty(opts.mind) && Boolean(opts.nowMs) && Boolean(opts.mind.updated_at) && mindAge > SESSION_GAP_MS);
  const insight = !mindIsEmpty(opts.mind) && !stale ? opts.mind.insight.trim() : "";
  const inner = insight
    ? `【内心】
${insight}

`
    : "";

  let tail = `现在是${opts.clock}。

${inner}【可以用的记忆】
${formatMemories(opts.notes, opts.timeZone)}

说话要有逻辑：观点有依据，前后一致。`;

  if (opts.careHint) {
    tail += "\n如果时机自然，可以像平常关心一样问问她今天过得怎么样、睡得如何。";
  }
  return tail;
}

export function buildVoiceMessages(opts: {
  charter: string;
  selfSummary?: string;
  bondSummary?: string;
  portrait?: PortraitRow[];
  longterm?: string;
  history: StoredMessage[];
  tail: string;
  userText: string;
  voiceTemplate?: string;
  vars?: Record<string, string>;
}): VoiceChatMessage[] {
  const template = opts.voiceTemplate ?? defaultPrompt("voice");
  const long =
    opts.longterm ??
    renderVoiceLongterm(opts.selfSummary ?? "", opts.bondSummary ?? "", opts.portrait ?? []);
  const vars: Record<string, string> = {
    system_prompt: opts.charter.trim() || FALLBACK_CHARTER,
    self: opts.selfSummary ?? "",
    bond: opts.bondSummary ?? "",
    portrait: opts.portrait ? portraitBlock(opts.portrait) : "",
    history: historyText(opts.history),
    tail: opts.tail,
    ...opts.vars,
  };
  const charter = fillTemplate(template, vars).trim();
  const history = opts.history.slice(-HISTORY_WINDOW).map((m) => ({
    role: m.role as "user" | "assistant",
    content: modelFacingText(m.text),
  }));
  const msgs: VoiceChatMessage[] = [{ role: "system", content: charter }];
  const inlineLong = templateHas(template, "self") || templateHas(template, "bond") || templateHas(template, "portrait");
  if (!inlineLong) msgs.push({ role: "system", content: long });
  if (!templateHas(template, "history")) msgs.push(...history);
  const inlineTail = templateHas(template, "tail") || templateHas(template, "memories") || templateHas(template, "clock");
  if (!inlineTail) msgs.push({ role: "system", content: opts.tail });
  msgs.push({ role: "user", content: opts.userText });
  return msgs;
}

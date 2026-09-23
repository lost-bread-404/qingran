import { HISTORY_WINDOW, PORTRAIT_MAX_CHARS, SESSION_GAP_MS } from "../config.ts";
import { defaultDoc, parsePromptBody, renderPromptMessages, variantMessages } from "../prompts/doc.ts";
import { fillTemplate } from "../prompts/fill.ts";
import { MIND_NOT_SPOKEN } from "../prompts/templates.ts";
import { formatClock } from "../time.ts";
import type { Mind, Note, PortraitRow, StoredMessage, VoiceChatMessage } from "../types.ts";
import { EMPTY_MIND } from "../types.ts";
import { isNightNoiseBody, modelFacingText } from "../../message-markup.ts";
import {
  formatVoiceInjectLine,
  voiceInjectFromProfile,
  type VoiceInjectFlags,
} from "../../types.ts";
import { asQingranFirstPerson } from "./person.ts";

export { formatVoiceInjectLine };
export type { VoiceInjectFlags };

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

function faceVoice(text: string): string {
  return asQingranFirstPerson(text);
}

/** Text of the five reply slots after the first-person rewrite. Empty mind stays empty. */
export function voiceFacingSlots(input: {
  selfSummary?: string;
  bondSummary?: string;
  portrait?: PortraitRow[];
  mind?: string;
  memories?: string;
}): { self: string; bond: string; portrait: string; mind: string; memories: string } {
  return {
    self: faceVoice(input.selfSummary?.trim() || "（还在过自己的日子）"),
    bond: faceVoice(input.bondSummary?.trim() || "（还在一点点建立）"),
    portrait: faceVoice(input.portrait ? portraitBlock(input.portrait) : "（还在慢慢认识她）"),
    mind: input.mind?.trim() ? faceVoice(input.mind.trim()) : "",
    memories: faceVoice(input.memories?.trim() || "（这一刻没有特别要提起的）"),
  };
}

export function renderVoiceLongterm(selfSummary: string, bondSummary: string, portrait: PortraitRow[]): string {
  const slots = voiceFacingSlots({ selfSummary, bondSummary, portrait });
  const template = variantMessages(defaultDoc("voice"), "main").find((message) => message.content.includes("{portrait}"));
  return fillTemplate(template?.content ?? "【我自己】{self}\n【我们】{bond}\n【我眼中的她】{portrait}", {
    self: slots.self,
    bond: slots.bond,
    portrait: slots.portrait,
  });
}

export function formatMemories(notes: Note[], timeZone: string): string {
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
  injectMemories?: boolean;
  injectLongterm?: boolean;
  historyWindow?: number;
};

export type VoiceInputChars = {
  system: number;
  mind: number;
  notes: number;
  history: number;
  user: number;
};

const FALLBACK_CHARTER = "你就是清然。正在和 Rosie 语音通话。";
const CARE_LINE = "\n如果时机自然，可以像平常关心一样问问你今天过得怎么样、睡得如何。";

export function voiceCareText(careHint: boolean): string {
  return careHint ? CARE_LINE : "";
}

export function voiceMindText(opts: {
  mind: Mind;
  nowMs?: number;
  stale?: boolean;
}): string {
  const mindAge = (opts.nowMs ?? 0) - (opts.mind.updated_at ?? 0);
  const stale =
    opts.stale ??
    (!mindIsEmpty(opts.mind) && Boolean(opts.nowMs) && Boolean(opts.mind.updated_at) && mindAge > SESSION_GAP_MS);
  if (mindIsEmpty(opts.mind) || stale) return "";
  return opts.mind.insight.trim();
}

export function voiceInjectOf(parts: {
  injectMemories?: boolean;
  injectLongterm?: boolean;
  historyWindow?: number;
}): VoiceInjectFlags {
  return voiceInjectFromProfile({
    injectMemories: parts.injectMemories !== false,
    injectLongterm: parts.injectLongterm !== false,
    historyWindow: parts.historyWindow ?? HISTORY_WINDOW,
  });
}

/** Drop an empty 【内心】 block, including the line that says not to speak it. A real insight stays. */
export function omitEmptyMindBlock(text: string): string {
  const marker = "【内心】";
  const at = text.indexOf(marker);
  if (at < 0) return text;
  const after = text.slice(at + marker.length);
  const next = after.search(/\n【|说话要有逻辑/);
  const body = (next < 0 ? after : after.slice(0, next)).trim();
  if (body) return text;
  let start = at;
  const before = text.slice(0, at);
  const leadAt = before.lastIndexOf(MIND_NOT_SPOKEN);
  if (leadAt >= 0 && before.slice(leadAt + MIND_NOT_SPOKEN.length).trim() === "") start = leadAt;
  const end = next < 0 ? text.length : at + marker.length + next;
  return `${text.slice(0, start)}${text.slice(end)}`.replace(/\n{3,}/g, "\n\n");
}

/** Remove the memories section entirely, heading included. */
export function omitMemoryBlock(text: string): string {
  const marker = "【可以用的记忆】";
  const at = text.indexOf(marker);
  if (at < 0) return text;
  const after = text.slice(at + marker.length);
  const next = after.search(/\n说话要有逻辑|\n【/);
  const end = next < 0 ? text.length : at + marker.length + next;
  return `${text.slice(0, at)}${text.slice(end)}`.replace(/\n{3,}/g, "\n\n");
}

function polishVoiceSystem(content: string, inject: VoiceInjectFlags): string {
  let next = content;
  if (!inject.memories) next = omitMemoryBlock(next);
  next = omitEmptyMindBlock(next);
  return next;
}

const LONGTERM_TOKEN = /\{(?:self|bond|portrait)\}/;
const OTHER_VOICE_TOKEN = /\{(?:system_prompt|user_text|history_messages|clock|mind|memories|care)\}/;

function withoutLongtermMessage<T extends { content: string }>(messages: T[], inject: VoiceInjectFlags): T[] {
  if (inject.longterm) return messages;
  return messages.filter((message) => !(LONGTERM_TOKEN.test(message.content) && !OTHER_VOICE_TOKEN.test(message.content)));
}

export function voiceHistoryMessages(
  history: StoredMessage[],
  limit = HISTORY_WINDOW,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (limit <= 0) return [];
  return history
    .filter((message) => !isNightNoiseBody(message.text))
    .slice(-limit)
    .map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: modelFacingText(message.text),
  }));
}

function voiceDoc(template?: string) {
  return parsePromptBody("voice", template);
}

function firstSystemTemplate(template?: string): string {
  const message = variantMessages(voiceDoc(template), "main").find(
    (item) => item.role === "system" && item.content.trim() !== "{history_messages}",
  );
  return message?.content ?? "";
}

export function systemCharter(charter: string, template?: string): string {
  return fillTemplate(firstSystemTemplate(template), {
    system_prompt: charter.trim() || FALLBACK_CHARTER,
  }).trim();
}

function voiceVars(parts: {
  charter: string;
  selfSummary?: string;
  bondSummary?: string;
  portrait?: PortraitRow[];
  clock: string;
  mind: string;
  memories: string;
  care: string;
  userText: string;
  inject: VoiceInjectFlags;
}): Record<string, string> {
  const longterm = parts.inject.longterm;
  const slots = voiceFacingSlots({
    selfSummary: parts.selfSummary,
    bondSummary: parts.bondSummary,
    portrait: parts.portrait,
    mind: parts.mind,
    memories: parts.memories,
  });
  return {
    system_prompt: parts.charter.trim() || FALLBACK_CHARTER,
    self: longterm ? slots.self : "",
    bond: longterm ? slots.bond : "",
    portrait: longterm ? slots.portrait : "",
    clock: parts.clock,
    mind: slots.mind,
    memories: parts.inject.memories ? slots.memories : "",
    care: parts.care,
    user_text: parts.userText,
  };
}

export function voiceMessagesForStrip(parts: VoicePackParts, strip: VoiceStrip): VoiceChatMessage[] {
  const inject = voiceInjectOf(parts);
  const mind = strip === "none" ? parts.mind : EMPTY_MIND;
  const notes = strip === "none" || strip === "mind" ? parts.notes : [];
  const rendered = buildVoiceMessages({
    charter: parts.charter,
    selfSummary: parts.selfSummary,
    bondSummary: parts.bondSummary,
    portrait: parts.portrait,
    history: parts.history,
    userText: parts.userText,
    mind,
    notes,
    clock: parts.clockText,
    timeZone: parts.timeZone,
    careHint: parts.careHint,
    nowMs: parts.nowMs,
    stale: strip === "none" ? parts.mindStale : false,
    voiceTemplate: parts.voiceTemplate,
    inject,
  });
  if (strip !== "thin") return rendered;
  const first = rendered.find((message) => message.role === "system") ?? {
    role: "system" as const,
    content: systemCharter(parts.charter, parts.voiceTemplate),
  };
  const cap = inject.history <= 0 ? 0 : Math.min(VOICE_THIN_HISTORY, inject.history);
  const history = voiceHistoryMessages(parts.history, cap);
  const last = rendered[rendered.length - 1];
  const user = last?.role === "user" ? last : { role: "user" as const, content: parts.userText };
  return [first, ...history, user];
}

export function voiceInputChars(parts: VoicePackParts): VoiceInputChars {
  const inject = voiceInjectOf(parts);
  const mind = faceVoice(voiceMindText({ mind: parts.mind, nowMs: parts.nowMs, stale: parts.mindStale }));
  const history = voiceHistoryMessages(parts.history, inject.history);
  return {
    system: systemCharter(parts.charter, parts.voiceTemplate).length,
    mind: mind.length,
    notes: inject.memories && parts.notes.length ? faceVoice(formatMemories(parts.notes, parts.timeZone)).length : 0,
    history: history.reduce((n, m) => n + m.content.length, 0),
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
  inject?: VoiceInjectFlags;
}): string {
  const inject = partsInject(opts.inject);
  const template = variantMessages(defaultDoc("voice"), "main").find(
    (message) => message.content.includes("{memories}") && message.content.includes("{clock}"),
  );
  const slots = voiceFacingSlots({
    mind: voiceMindText(opts),
    memories: formatMemories(opts.notes, opts.timeZone),
  });
  const filled = fillTemplate(template?.content ?? "", {
    clock: opts.clock,
    mind: slots.mind,
    memories: inject.memories ? slots.memories : "",
    care: voiceCareText(opts.careHint),
  });
  return polishVoiceSystem(filled, inject);
}

function partsInject(inject?: VoiceInjectFlags): VoiceInjectFlags {
  return inject ?? { memories: true, longterm: true, history: HISTORY_WINDOW };
}

export function buildVoiceMessages(opts: {
  charter: string;
  selfSummary?: string;
  bondSummary?: string;
  portrait?: PortraitRow[];
  longtermOverride?: string | null;
  history: StoredMessage[];
  userText: string;
  mind?: Mind;
  notes?: Note[];
  clock?: string;
  timeZone?: string;
  careHint?: boolean;
  nowMs?: number;
  stale?: boolean;
  voiceTemplate?: string;
  inject?: VoiceInjectFlags;
}): VoiceChatMessage[] {
  const inject = partsInject(opts.inject);
  const doc = voiceDoc(opts.voiceTemplate);
  let messages = variantMessages(doc, "main").map((message) => ({ ...message }));
  messages = withoutLongtermMessage(messages, inject);
  if (inject.longterm && opts.longtermOverride != null) {
    const idx = messages.findIndex((message) => /\{self\}|\{bond\}|\{portrait\}/.test(message.content));
    if (idx >= 0) messages[idx] = { role: "system", content: opts.longtermOverride };
  }
  const mind = voiceMindText({
    mind: opts.mind ?? EMPTY_MIND,
    nowMs: opts.nowMs,
    stale: opts.stale,
  });
  return renderPromptMessages(
    messages,
    voiceVars({
      charter: opts.charter,
      selfSummary: opts.selfSummary,
      bondSummary: opts.bondSummary,
      portrait: opts.portrait,
      clock: opts.clock ?? "",
      mind,
      memories: formatMemories(opts.notes ?? [], opts.timeZone ?? "UTC"),
      care: voiceCareText(Boolean(opts.careHint)),
      userText: opts.userText,
      inject,
    }),
    voiceHistoryMessages(opts.history, inject.history),
  )
    .map((message) =>
      message.role === "system" ? { ...message, content: polishVoiceSystem(message.content, inject) } : message,
    )
    .filter((message) => message.role !== "system" || message.content.trim());
}

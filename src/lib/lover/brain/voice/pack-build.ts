import { HISTORY_WINDOW, PORTRAIT_MAX_CHARS } from "../config.ts";
import { defaultDoc, parsePromptBody, renderPromptMessages, variantMessages } from "../prompts/doc.ts";
import { fillTemplate } from "../prompts/fill.ts";
import type { MomentText } from "../mind-parse.ts";
import type { Mind, Note, PortraitRow, StoredMessage, VoiceChatMessage } from "../types.ts";
import { isNightNoiseBody, modelFacingText } from "../../message-markup.ts";
import {
  NEUTRAL_PERSONA,
  formatVoiceInjectLine,
  voiceInjectFromProfile,
  type VoiceInjectFlags,
} from "../../types.ts";

export { formatVoiceInjectLine };
export type { VoiceInjectFlags };

export const EMPTY_MOMENT: MomentText = { feel: "", desire: "", now: "", longing: "", glow: "" };

function portraitBlock(rows: PortraitRow[]): string {
  const active = rows.filter((r) => r.status === "active");
  if (!active.length) return "（还在慢慢认识她）";
  const lines = active.map((r) => `${r.topic}：${r.body}`);
  let text = lines.join("\n");
  if (text.length > PORTRAIT_MAX_CHARS) text = `${text.slice(0, PORTRAIT_MAX_CHARS - 1)}…`;
  return text;
}

/** Self / bond / portrait, as stored. Used only until Rosie enables the dossier. */
export function dossierSections(selfSummary: string, bondSummary: string, portrait: PortraitRow[]): string {
  const self = selfSummary.trim() || "（还在过自己的日子）";
  const bond = bondSummary.trim() || "（还在一点点建立）";
  return `【我自己】\n${self}\n【我们】\n${bond}\n【我眼中的她】\n${portraitBlock(portrait)}`;
}

export function renderDossierBlock(dossier: string): string {
  const template = variantMessages(defaultDoc("voice"), "main").find((message) => message.content.includes("{dossier}"));
  return fillTemplate(template?.content ?? "【我记得的】\n{dossier}", {
    dossier: dossier.trim() || "（还没有）",
  });
}

export function renderVoiceLongterm(selfSummary: string, bondSummary: string, portrait: PortraitRow[]): string {
  return renderDossierBlock(dossierSections(selfSummary, bondSummary, portrait));
}

export const VOICE_THIN_HISTORY = 8;
export type VoiceStrip = "none" | "moment" | "dossier" | "thin";
export const VOICE_STRIPS: VoiceStrip[] = ["none", "moment", "dossier", "thin"];

export type VoicePackParts = {
  charter: string;
  identity?: string;
  longterm: string;
  history: StoredMessage[];
  userText: string;
  moment: MomentText;
  clockText: string;
  timeZone: string;
  nowMs: number;
  voiceTemplate?: string;
  selfSummary?: string;
  bondSummary?: string;
  portrait?: PortraitRow[];
  injectMoment?: boolean;
  injectDossier?: boolean;
  historyWindow?: number;
  personaPlacement?: "system" | "first_user";
  personaAck?: string;
  /** Already decided: empty means do not inject. */
  intimateNotes?: string;
  /** Legacy rebuild only. Notes are not injected on the live path. */
  showMemories?: boolean;
  mindText?: string;
  memoriesText?: string;
};

export type VoiceInputChars = {
  system: number;
  moment: number;
  dossier: number;
  history: number;
  user: number;
};

const FALLBACK_CHARTER = NEUTRAL_PERSONA;
const MOMENT_FIELD = /\{(feel|desire|want|longing|now|glow)\}/;
const DOSSIER_TOKEN = /\{(?:dossier|self|bond|portrait)\}/;
const OTHER_VOICE_TOKEN = /\{(?:system_prompt|identity_block|user_text|history_messages|clock|feel|desire|want|longing|now|glow|mind|memories)\}/;

export function voiceInjectOf(parts: {
  injectMoment?: boolean;
  injectDossier?: boolean;
  historyWindow?: number;
}): VoiceInjectFlags {
  return voiceInjectFromProfile({
    injectMind: parts.injectMoment !== false,
    injectLongterm: parts.injectDossier !== false,
    historyWindow: parts.historyWindow ?? HISTORY_WINDOW,
  });
}

/** Drop an empty 【内心】 block left by an older saved voice template. */
export function omitEmptyMindBlock(text: string): string {
  const marker = "【内心】";
  const at = text.indexOf(marker);
  if (at < 0) return text;
  const after = text.slice(at + marker.length);
  const next = after.search(/\n【/);
  const body = (next < 0 ? after : after.slice(0, next)).trim();
  if (body) return text;
  const end = next < 0 ? text.length : at + marker.length + next;
  return `${text.slice(0, at)}${text.slice(end)}`.replace(/\n{3,}/g, "\n\n");
}

/** Remove the memories section entirely, heading included. */
export function omitMemoryBlock(text: string): string {
  const marker = "【可以用的记忆】";
  const at = text.indexOf(marker);
  if (at < 0) return text;
  const after = text.slice(at + marker.length);
  const next = after.search(/\n【/);
  const end = next < 0 ? text.length : at + marker.length + next;
  return `${text.slice(0, at)}${text.slice(end)}`.replace(/\n{3,}/g, "\n\n");
}

function withoutDossierMessage<T extends { content: string }>(messages: T[], inject: VoiceInjectFlags): T[] {
  if (inject.dossier) return messages;
  return messages.filter((message) => !(DOSSIER_TOKEN.test(message.content) && !OTHER_VOICE_TOKEN.test(message.content)));
}

function prepareMomentTemplate(content: string, moment: MomentText, enabled: boolean): string {
  if (!content.includes("【我此刻】") && !MOMENT_FIELD.test(content)) return content;
  const values: Record<string, string> = moment;
  const any = ["feel", "desire", "now", "glow"].some((key) => values[key]?.trim());
  if (!enabled || !any) return "";
  return content
    .split("\n")
    .filter((line) => {
      const hit = line.match(MOMENT_FIELD);
      if (!hit) return true;
      return Boolean(values[hit[1]!]?.trim());
    })
    .join("\n");
}

/** How many of his latest replies stay word for word; older ones keep only what he said aloud. */
export const VERBATIM_REPLIES = 2;

/**
 * Like a person remembers a conversation: the gist of what he said, not every gesture.
 * Older replies drop their action narration so the model stops copying its own template and growing it.
 */
export function spokenOnly(text: string): string {
  const quotes = [...text.matchAll(/[“"「]([^”"」]{1,200})[”"」]/g)].map((m) => m[1]!.trim()).filter(Boolean);
  if (quotes.length) return quotes.map((q) => `“${q}”`).join(" ");
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

export function voiceHistoryMessages(
  history: StoredMessage[],
  limit = HISTORY_WINDOW,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (limit <= 0) return [];
  const rows = history.filter((message) => !isNightNoiseBody(message.text)).slice(-limit);
  let replies = 0;
  const keep = new Set<number>();
  for (let i = rows.length - 1; i >= 0 && replies < VERBATIM_REPLIES; i -= 1) {
    if (rows[i]!.role === "assistant") {
      keep.add(i);
      replies += 1;
    }
  }
  return rows.map((message, i) => {
    const text = modelFacingText(message.text);
    const assistant = message.role === "assistant";
    return {
      role: assistant ? "assistant" : "user",
      content: assistant && !keep.has(i) ? spokenOnly(text) : text,
    };
  });
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
    identity_block: "",
  }).trim();
}

function voiceVars(parts: {
  charter: string;
  identity?: string;
  dossier: string;
  clock: string;
  moment: MomentText;
  userText: string;
  mindText: string;
  memoriesText: string;
  placement?: "system" | "first_user";
}): Record<string, string> {
  const personaInSystem = parts.placement !== "first_user";
  return {
    system_prompt: personaInSystem ? parts.charter.trim() || FALLBACK_CHARTER : "",
    identity_block: parts.identity?.trim() ? `${parts.identity.trim()}\n` : "",
    dossier: parts.dossier,
    self: "",
    bond: "",
    portrait: "",
    clock: parts.clock,
    feel: parts.moment.feel.trim(),
    desire: parts.moment.desire.trim(),
    want: parts.moment.desire.trim(),
    longing: parts.moment.longing.trim(),
    now: parts.moment.now.trim(),
    glow: parts.moment.glow.trim(),
    plans: "",
    mind: parts.mindText,
    memories: parts.memoriesText,
    user_text: parts.userText,
  };
}

export function voiceMessagesForStrip(parts: VoicePackParts, strip: VoiceStrip): VoiceChatMessage[] {
  const inject = voiceInjectOf(parts);
  const moment = strip === "none" ? parts.moment : EMPTY_MOMENT;
  const dossierOn = strip === "none" || strip === "moment";
  const useStoredLongterm = Boolean(parts.longterm) && !parts.selfSummary && !parts.bondSummary && !parts.portrait?.length;
  const rendered = buildVoiceMessages({
    charter: parts.charter,
    selfSummary: parts.selfSummary,
    bondSummary: parts.bondSummary,
    portrait: parts.portrait,
    longtermOverride: useStoredLongterm ? parts.longterm : null,
    history: parts.history,
    userText: parts.userText,
    moment,
    clock: parts.clockText,
    identity: parts.identity,
    voiceTemplate: parts.voiceTemplate,
    showMemories: parts.showMemories === true && (strip === "none" || strip === "moment"),
    mindText: strip === "none" ? parts.mindText : "",
    memoriesText: strip === "none" || strip === "moment" ? parts.memoriesText : "",
    personaPlacement: parts.personaPlacement,
    personaAck: parts.personaAck,
    intimateNotes: parts.intimateNotes,
    inject: {
      moment: inject.moment && strip === "none",
      dossier: inject.dossier && dossierOn,
      history: inject.history,
    },
  });
  if (strip !== "thin") return rendered;
  const head = rendered.find((message) => message.role === "system") ?? {
    role: "system" as const,
    content: systemCharter(parts.charter, parts.voiceTemplate),
  };
  const cap = inject.history <= 0 ? 0 : Math.min(VOICE_THIN_HISTORY, inject.history);
  const history = voiceHistoryMessages(parts.history, cap);
  const last = rendered[rendered.length - 1];
  const user = last?.role === "user" ? last : { role: "user" as const, content: parts.userText };
  const intimate = rendered.find((message) => message.content.startsWith("你在亲密时的样子："));
  const persona =
    parts.personaPlacement === "first_user"
      ? rendered.filter(
          (message, index) =>
            (message.role === "user" && message.content === (parts.charter.trim() || FALLBACK_CHARTER) && rendered[index + 1]?.role === "assistant") ||
            (message.role === "assistant" &&
              index > 0 &&
              rendered[index - 1]?.role === "user" &&
              rendered[index - 1]?.content === (parts.charter.trim() || FALLBACK_CHARTER)),
        )
      : [];
  const middle = [...(intimate ? [intimate] : []), ...persona, ...history];
  return [head, ...middle, user];
}

export function voiceInputChars(parts: VoicePackParts): VoiceInputChars {
  const inject = voiceInjectOf(parts);
  const history = voiceHistoryMessages(parts.history, inject.history);
  const moment = inject.moment
    ? [parts.moment.feel, parts.moment.desire, parts.moment.now, parts.moment.glow].filter((line) => line.trim()).join("\n")
    : "";
  const dossier = inject.dossier
    ? parts.longterm || dossierSections(parts.selfSummary ?? "", parts.bondSummary ?? "", parts.portrait ?? [])
    : "";
  return {
    system: systemCharter(parts.charter, parts.voiceTemplate).length,
    moment: moment.length,
    dossier: dossier.length,
    history: history.reduce((n, m) => n + m.content.length, 0),
    user: parts.userText.length,
  };
}

export function formatVoiceInputCharsLine(c: VoiceInputChars): string {
  return `chars system=${c.system} moment=${c.moment} dossier=${c.dossier} history=${c.history} user=${c.user}`;
}

export function parseVoiceInputCharsLine(note: string | null | undefined): VoiceInputChars | null {
  const text = note ?? "";
  const next = text.match(/chars system=(\d+) moment=(\d+) dossier=(\d+) history=(\d+) user=(\d+)/);
  if (next) {
    return {
      system: Number(next[1]),
      moment: Number(next[2]),
      dossier: Number(next[3]),
      history: Number(next[4]),
      user: Number(next[5]),
    };
  }
  const old = text.match(/chars system=(\d+) mind=(\d+) notes=(\d+) history=(\d+) user=(\d+)/);
  if (!old) return null;
  return {
    system: Number(old[1]),
    moment: Number(old[2]),
    dossier: Number(old[3]),
    history: Number(old[4]),
    user: Number(old[5]),
  };
}

export function stripLabel(strip: VoiceStrip): string {
  if (strip === "moment") return "去掉了【我此刻】";
  if (strip === "dossier") return "去掉了【我此刻】和【我记得的】";
  if (strip === "thin") return "只保留 system prompt、最近 8 条对话和用户消息";
  return "未裁剪";
}

export function buildTail(opts: {
  clock: string;
  moment?: MomentText;
  inject?: VoiceInjectFlags;
}): string {
  const inject = opts.inject ?? { moment: true, dossier: true, history: HISTORY_WINDOW };
  const moment = opts.moment ?? EMPTY_MOMENT;
  const template = variantMessages(defaultDoc("voice"), "main").find((message) => message.content.includes("{now}"));
  const clock = variantMessages(defaultDoc("voice"), "main").find((message) => message.content.includes("{clock}"));
  const momentText = prepareMomentTemplate(template?.content ?? "", moment, inject.moment);
  const filledMoment = momentText
    ? fillTemplate(momentText, {
        feel: moment.feel,
        desire: moment.desire,
        want: moment.desire,
        longing: moment.longing,
        now: moment.now,
        glow: moment.glow,
      })
    : "";
  const filledClock = fillTemplate(clock?.content ?? "现在是{clock}。", { clock: opts.clock });
  return [filledMoment, filledClock].filter(Boolean).join("\n\n");
}

function partsInject(inject?: VoiceInjectFlags): VoiceInjectFlags {
  return inject ?? { moment: true, dossier: true, history: HISTORY_WINDOW };
}

export function buildVoiceMessages(opts: {
  charter: string;
  selfSummary?: string;
  bondSummary?: string;
  portrait?: PortraitRow[];
  longtermOverride?: string | null;
  history: StoredMessage[];
  userText: string;
  moment?: MomentText;
  clock?: string;
  identity?: string;
  timeZone?: string;
  voiceTemplate?: string;
  inject?: VoiceInjectFlags;
  showMemories?: boolean;
  mindText?: string;
  memoriesText?: string;
  personaPlacement?: "system" | "first_user";
  personaAck?: string;
  intimateNotes?: string;
  /** Rebuild of an older saved template may still pass these. */
  mind?: Mind;
  notes?: Note[];
}): VoiceChatMessage[] {
  const inject = partsInject(opts.inject);
  const doc = voiceDoc(opts.voiceTemplate);
  let messages = variantMessages(doc, "main").map((message) => ({ ...message }));
  messages = withoutDossierMessage(messages, inject);
  if (inject.dossier && opts.longtermOverride != null) {
    const idx = messages.findIndex(
      (message) => DOSSIER_TOKEN.test(message.content) && !OTHER_VOICE_TOKEN.test(message.content),
    );
    if (idx >= 0) messages[idx] = { role: "system", content: opts.longtermOverride };
  }
  const moment = opts.moment ?? EMPTY_MOMENT;
  const dossier = opts.longtermOverride != null ? "" : dossierSections(opts.selfSummary ?? "", opts.bondSummary ?? "", opts.portrait ?? []);
  const vars = voiceVars({
    charter: opts.charter,
    identity: opts.identity,
    dossier,
    clock: opts.clock ?? "",
    moment,
    userText: opts.userText,
    mindText: opts.mindText ?? opts.mind?.insight ?? "",
    memoriesText: opts.showMemories ? opts.memoriesText ?? "" : "",
    placement: opts.personaPlacement,
  });
  messages = messages
    .map((message) => ({ ...message, content: prepareMomentTemplate(message.content, moment, inject.moment) }))
    .filter((message) => message.content.trim());
  const rendered = renderPromptMessages(messages, vars, voiceHistoryMessages(opts.history, inject.history))
    .map((message) => {
      if (message.role !== "system") return message;
      let content = message.content;
      if (!opts.showMemories) content = omitMemoryBlock(content);
      content = omitEmptyMindBlock(content);
      return { ...message, content };
    })
    .filter((message) => message.role !== "system" || message.content.trim());
  return placePersona(
    insertIntimateNotes(rendered, opts.intimateNotes ?? ""),
    {
      placement: opts.personaPlacement ?? "system",
      charter: opts.charter,
      ack: opts.personaAck ?? "嗯。",
    },
  );
}

export function insertIntimateNotes<T extends { role: string; content: string }>(messages: T[], notes: string): T[] {
  const text = notes.trim();
  if (!text) return messages;
  const block = { role: "system", content: `你在亲密时的样子：\n${text}` } as T;
  const moment = messages.findIndex((message) => message.content.includes("【我此刻】") || message.content.startsWith("你心里此刻"));
  if (moment >= 0) return [...messages.slice(0, moment + 1), block, ...messages.slice(moment + 1)];
  const at = messages.findIndex((message) => message.role !== "system");
  const index = at < 0 ? messages.length : at;
  return [...messages.slice(0, index), block, ...messages.slice(index)];
}

export function placePersona<T extends { role: "system" | "user" | "assistant"; content: string }>(
  messages: T[],
  opts: { placement: "system" | "first_user"; charter: string; ack: string },
): T[] {
  if (opts.placement !== "first_user") return messages;
  const persona = opts.charter.trim() || FALLBACK_CHARTER;
  const ack = opts.ack.trim() || "嗯。";
  const at = messages.findIndex((message) => message.role !== "system");
  const index = at < 0 ? messages.length : at;
  const block = [
    { role: "user", content: persona },
    { role: "assistant", content: ack },
  ] as T[];
  return [...messages.slice(0, index), ...block, ...messages.slice(index)];
}

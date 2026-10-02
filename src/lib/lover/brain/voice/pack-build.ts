import { HISTORY_WINDOW } from "../config.ts";
import { parsePromptBody, renderPromptMessages, variantMessages } from "../prompts/doc.ts";
import { fillTemplate } from "../prompts/fill.ts";
import type { StoredMessage, VoiceChatMessage } from "../types.ts";
import { isNightNoiseBody, modelFacingText } from "../../message-markup.ts";
import { NEUTRAL_PERSONA } from "../../types.ts";

/**
 * What the reply is given (docs/brain.md「回复看到的」):
 * persona with his intimate side (+ identity) → 清然和 Rosie 现在 → today's talk → 清然此刻想起来的事 → 现在是… + how to talk
 * → her line.
 * A block whose value is empty is left out.
 */
export type VoicePackParts = {
  charter: string;
  identity: string;
  /** 清然和 Rosie 现在: the short text the night pass rewrites ("" = not injected). */
  us: string;
  /** The moments that came back to him for this line, already written out ("" = none). */
  recall: string;
  clock: string;
  history: StoredMessage[];
  historyWindow: number;
  userText: string;
  /** Set when he may write first (nothing from her to answer): the「主动找她」variant. */
  first?: { quiet: string };
  voiceTemplate?: string;
  personaPlacement: "system" | "first_user";
  personaAck: string;
};

/** Retries when the model returns nothing (usually a refusal): drop what came back to him, then almost everything. */
export type VoiceStrip = "none" | "memory" | "thin";
export const VOICE_STRIPS: VoiceStrip[] = ["none", "memory", "thin"];
export const VOICE_THIN_HISTORY = 8;

export function stripLabel(strip: VoiceStrip): string {
  if (strip === "memory") return "去掉了想起来的事和现在的我们";
  if (strip === "thin") return "只保留人设、最近 8 条对话和这一句";
  return "未裁剪";
}

/**
 * His lines with the actions taken out, for the night pass in modes that do not keep actions.
 * The reply always reads his replies whole: without the actions he loses track of the scene.
 */
export function spokenOnly(text: string): string {
  const quotes = [...text.matchAll(/[“"「]([^”"」]{1,200})[”"」]/g)].map((m) => m[1]!.trim()).filter(Boolean);
  if (quotes.length) return quotes.map((q) => `“${q}”`).join(" ");
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/** A pause this long between two messages is marked in the talk, so a new morning does not read as the same night. */
export const GAP_MARK_MS = 30 * 60_000;

function gapText(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} 分钟`;
  return m % 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${Math.floor(m / 60)} 小时`;
}

export function voiceHistoryMessages(
  history: StoredMessage[],
  limit = HISTORY_WINDOW,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  if (limit <= 0) return [];
  const rows = history.filter((message) => !isNightNoiseBody(message.text)).slice(-limit);
  const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  rows.forEach((message, i) => {
    const gap = i > 0 ? message.createdAt - rows[i - 1]!.createdAt : 0;
    if (gap >= GAP_MARK_MS) out.push({ role: "system", content: `（过了 ${gapText(gap)}）` });
    out.push({ role: message.role === "assistant" ? "assistant" : "user", content: modelFacingText(message.text) });
  });
  return out;
}

/** Tokens whose block disappears when their value is empty. */
const OPTIONAL = ["us", "recall"] as const;

function optionalTokens(content: string): string[] {
  return OPTIONAL.filter((token) => content.includes(`{${token}}`));
}

export function buildVoiceMessages(parts: VoicePackParts, strip: VoiceStrip = "none"): VoiceChatMessage[] {
  const charter = parts.charter.trim() || NEUTRAL_PERSONA;
  const personaInSystem = parts.personaPlacement !== "first_user";
  const vars: Record<string, string> = {
    system_prompt: personaInSystem ? charter : "",
    identity_block: parts.identity.trim() ? `${parts.identity.trim()}\n` : "",
    us: strip === "none" ? parts.us.trim() : "",
    recall: strip === "none" ? parts.recall.trim() : "",
    clock: parts.clock,
    user_text: parts.userText,
    quiet: parts.first?.quiet ?? "",
  };
  const variant = parts.first ? "first" : "main";
  const template = variantMessages(parsePromptBody("voice", parts.voiceTemplate), variant).filter((message) => {
    const tokens = optionalTokens(message.content);
    return !tokens.length || tokens.some((token) => vars[token]);
  });
  const historyLimit = strip === "thin" ? Math.min(VOICE_THIN_HISTORY, parts.historyWindow) : parts.historyWindow;
  let rendered = renderPromptMessages(template, vars, voiceHistoryMessages(parts.history, historyLimit)).filter(
    (message) => message.role !== "system" || message.content.trim(),
  ) as VoiceChatMessage[];
  if (strip === "thin") {
    // Persona, recent talk, her line: the first system message and everything that is not a system message.
    const first = rendered.findIndex((message) => message.role === "system");
    rendered = rendered.filter((message, i) => message.role !== "system" || i === first);
  }
  return placePersona(rendered, {
    placement: parts.personaPlacement,
    charter,
    ack: parts.personaAck,
  });
}

export function placePersona<T extends { role: string; content: string }>(
  messages: T[],
  opts: { placement: "system" | "first_user"; charter: string; ack: string },
): T[] {
  if (opts.placement !== "first_user") return messages;
  const persona = opts.charter.trim() || NEUTRAL_PERSONA;
  const ack = opts.ack.trim() || "嗯。";
  const at = messages.findIndex((message) => message.role !== "system");
  const index = at < 0 ? messages.length : at;
  const block = [
    { role: "user", content: persona },
    { role: "assistant", content: ack },
  ] as T[];
  return [...messages.slice(0, index), ...block, ...messages.slice(index)];
}

/** The system text alone (persona + identity), for previews and size notes. */
export function systemCharter(charter: string, template?: string): string {
  const first = variantMessages(parsePromptBody("voice", template), "main").find(
    (message) => message.role === "system" && message.content.trim() !== "{history_messages}",
  );
  return fillTemplate(first?.content ?? "", { system_prompt: charter.trim() || NEUTRAL_PERSONA, identity_block: "" }).trim();
}

export type VoiceInputChars = {
  system: number;
  moment: number;
  story: number;
  history: number;
  user: number;
};

export function voiceInputChars(parts: VoicePackParts): VoiceInputChars {
  const history = voiceHistoryMessages(parts.history, parts.historyWindow);
  return {
    system: systemCharter(parts.charter, parts.voiceTemplate).length,
    moment: parts.us.length,
    story: parts.recall.length,
    history: history.reduce((n, m) => n + m.content.length, 0),
    user: parts.userText.length,
  };
}

export function formatVoiceInputCharsLine(c: VoiceInputChars): string {
  return `chars system=${c.system} moment=${c.moment} story=${c.story} history=${c.history} user=${c.user}`;
}

export function parseVoiceInputCharsLine(note: string | null | undefined): VoiceInputChars | null {
  const next = (note ?? "").match(/chars system=(\d+) moment=(\d+) (?:story|dossier)=(\d+) history=(\d+) user=(\d+)/);
  if (!next) return null;
  return {
    system: Number(next[1]),
    moment: Number(next[2]),
    story: Number(next[3]),
    history: Number(next[4]),
    user: Number(next[5]),
  };
}

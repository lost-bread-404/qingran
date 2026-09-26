import { HISTORY_WINDOW } from "../config.ts";
import { parsePromptBody, renderPromptMessages, variantMessages } from "../prompts/doc.ts";
import { fillTemplate } from "../prompts/fill.ts";
import type { StoredMessage, VoiceChatMessage } from "../types.ts";
import { isNightNoiseBody, modelFacingText } from "../../message-markup.ts";
import { NEUTRAL_PERSONA } from "../../types.ts";

/**
 * What the reply is given (docs/brain.md「回复看到的」):
 * persona (+ identity + current mode) → 你记得的 → 你心里 → 今天到现在 → intimate notes → 现在是… → recent talk → her line.
 * A block whose value is empty is left out.
 */
export type VoicePackParts = {
  charter: string;
  identity: string;
  /** 他记得的, whole text ("" = not injected). */
  dossier: string;
  /** heart + focus ("" = not injected). */
  mind: string;
  /** Today's running text ("" = not injected). */
  today: string;
  /** Intimate notes, already decided by the current mode ("" = not injected). */
  intimate: string;
  clock: string;
  history: StoredMessage[];
  historyWindow: number;
  userText: string;
  /** Set when he writes first (nothing from her to answer): the「主动找她」variant. */
  first?: { quiet: string; intent: string };
  voiceTemplate?: string;
  personaPlacement: "system" | "first_user";
  personaAck: string;
};

/** Retries when the model returns nothing (usually a refusal): drop his mind, then the memory, then almost everything. */
export type VoiceStrip = "none" | "moment" | "dossier" | "thin";
export const VOICE_STRIPS: VoiceStrip[] = ["none", "moment", "dossier", "thin"];
export const VOICE_THIN_HISTORY = 8;

export function stripLabel(strip: VoiceStrip): string {
  if (strip === "moment") return "去掉了心里和今天";
  if (strip === "dossier") return "去掉了心里、今天和记得的";
  if (strip === "thin") return "只保留人设、最近 8 条对话和这一句";
  return "未裁剪";
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

/** Tokens whose block disappears when their value is empty. */
const OPTIONAL = ["dossier", "now", "today"] as const;

function optionalTokens(content: string): string[] {
  return OPTIONAL.filter((token) => content.includes(`{${token}}`));
}

export function buildVoiceMessages(parts: VoicePackParts, strip: VoiceStrip = "none"): VoiceChatMessage[] {
  const charter = parts.charter.trim() || NEUTRAL_PERSONA;
  const personaInSystem = parts.personaPlacement !== "first_user";
  const vars: Record<string, string> = {
    system_prompt: personaInSystem ? charter : "",
    identity_block: parts.identity.trim() ? `${parts.identity.trim()}\n` : "",
    dossier: strip === "none" || strip === "moment" ? parts.dossier.trim() : "",
    now: strip === "none" ? parts.mind.trim() : "",
    today: strip === "none" ? parts.today.trim() : "",
    clock: parts.clock,
    user_text: parts.userText,
    quiet: parts.first?.quiet ?? "",
    intent: parts.first?.intent ?? "",
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
  return placePersona(insertIntimateNotes(rendered, parts.intimate), {
    placement: parts.personaPlacement,
    charter,
    ack: parts.personaAck,
  });
}

/** Intimate notes sit right after his heart (or, without it, just before the talk). */
export function insertIntimateNotes<T extends { role: string; content: string }>(messages: T[], notes: string): T[] {
  const text = notes.trim();
  if (!text) return messages;
  const block = { role: "system", content: `你在亲密时的样子：\n${text}` } as T;
  const heart = messages.findIndex((message) => message.role === "system" && message.content.startsWith("你心里"));
  const talk = messages.findIndex((message) => message.role !== "system");
  const at = heart >= 0 ? heart + 1 : talk >= 0 ? talk : messages.length;
  return [...messages.slice(0, at), block, ...messages.slice(at)];
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

/** The system text alone (persona + mode + identity), for previews and size notes. */
export function systemCharter(charter: string, template?: string): string {
  const first = variantMessages(parsePromptBody("voice", template), "main").find(
    (message) => message.role === "system" && message.content.trim() !== "{history_messages}",
  );
  return fillTemplate(first?.content ?? "", { system_prompt: charter.trim() || NEUTRAL_PERSONA, identity_block: "" }).trim();
}

export type VoiceInputChars = {
  system: number;
  moment: number;
  dossier: number;
  history: number;
  user: number;
};

export function voiceInputChars(parts: VoicePackParts): VoiceInputChars {
  const history = voiceHistoryMessages(parts.history, parts.historyWindow);
  return {
    system: systemCharter(parts.charter, parts.voiceTemplate).length,
    moment: parts.mind.length + parts.today.length,
    dossier: parts.dossier.length,
    history: history.reduce((n, m) => n + m.content.length, 0),
    user: parts.userText.length,
  };
}

export function formatVoiceInputCharsLine(c: VoiceInputChars): string {
  return `chars system=${c.system} moment=${c.moment} dossier=${c.dossier} history=${c.history} user=${c.user}`;
}

export function parseVoiceInputCharsLine(note: string | null | undefined): VoiceInputChars | null {
  const next = (note ?? "").match(/chars system=(\d+) moment=(\d+) dossier=(\d+) history=(\d+) user=(\d+)/);
  if (!next) return null;
  return {
    system: Number(next[1]),
    moment: Number(next[2]),
    dossier: Number(next[3]),
    history: Number(next[4]),
    user: Number(next[5]),
  };
}

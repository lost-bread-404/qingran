import { HISTORY_WINDOW } from "../config.ts";
import { fillParagraphs, parsePromptBody, renderPromptMessages, variantMessages } from "../prompts/doc.ts";
import type { StoredMessage, VoiceChatMessage } from "../types.ts";
import { modelFacingText } from "../../message-meta.ts";
import { DEFAULT_FORMATS, fmt, type Formats } from "../prompts/formats.ts";
import type { TimeFacts } from "../heart.ts";
import { NEUTRAL_PERSONA } from "../../types.ts";
import type { Engine } from "./engine.ts";

/**
 * What the reply is given (docs/brain.md「回复看到的」):
 * persona with his intimate side (+ identity) → 清然和 Rosie 现在 → today's talk → 清然此刻想起来的事 → 现在是…
 * → her line.
 * A block whose value is empty is left out.
 */
export type VoicePackParts = {
  /** The persona as she wrote it. */
  charter: string;
  /** 亲密设定 as she wrote it. */
  intimate: string;
  /** 身份 as she wrote it. */
  identity: string;
  /** 清然和 Rosie 现在: the short text the night pass rewrites ("" = not injected). */
  us: string;
  /** When that text was last written (「10 月 4 日 04:12」), so its words are read as of then. */
  usWhen?: string;
  /** The moments that came back to him for this line, already written out ("" = none). */
  recall: string;
  time: TimeFacts;
  /** His ｛｝ notes of the last 16 hours, one per line. */
  inner: string;
  /** The same, without those written while Grok was playing her (what Claude is given). */
  innerDaily: string;
  /**
   * Who these messages are for (docs/claude-grok-routing.md). Claude: no 亲密设定, no notes from a Grok scene, each
   * stretch Grok played folded into one line, its own instruction (指令 → 每轮回复（Claude）, ends with the handover).
   * Grok: 指令 → 每轮回复（Grok）, with 亲密设定, ends with handing it back. Missing = Grok.
   */
  engine?: Engine;
  /** Claude plays her day to day and hands sex to Grok (设置 → 回复 → Claude 分流). Off: Grok plays all of her. */
  routing?: boolean;
  /** Her persona for Claude day to day, and for Grok in bed (with routing on); `charter` is the one for Grok alone. */
  charterClaude?: string;
  charterGrok?: string;
  /** 材料的写法 (gaps and photos in the talk). */
  formats: Formats;
  history: StoredMessage[];
  historyWindow: number;
  /** When he is asked (a stretch Grok played that she left without a word is read as her falling asleep). */
  nowMs?: number;
  userText: string;
  /** Photos she sent with this line (qr_photos ids). */
  userImages?: string[];
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

/**
 * Said or written while Grok was playing her (a stretch it played). A line Grok wrote only because Claude failed is
 * not part of such a stretch: it stays in Claude's talk.
 */
export function inGrokScene(message: StoredMessage): boolean {
  return message.meta.scene === "grok";
}

export function voiceHistoryMessages(
  history: StoredMessage[],
  limit = HISTORY_WINDOW,
  f: Formats = DEFAULT_FORMATS,
  engine: Engine = "grok",
  nowMs?: number,
): VoiceChatMessage[] {
  if (limit <= 0) return [];
  const rows = history.filter((message) => !message.meta.nightNoise).slice(-limit);
  const out: VoiceChatMessage[] = [];
  const fold = fmt(f, "grokScene", {});
  // She went quiet after the intimate part (half an hour or more): she fell asleep in his arms (她 2026-10-04 定的).
  const asleep = fmt(f, "asleepAfter", {});
  const fellAsleep = (last: StoredMessage | undefined, gap: number) => {
    if (last && inGrokScene(last) && gap >= GAP_MARK_MS && asleep.trim()) out.push({ role: "system", content: asleep });
  };
  rows.forEach((message, i) => {
    const gap = i > 0 ? message.createdAt - rows[i - 1]!.createdAt : 0;
    fellAsleep(rows[i - 1], gap);
    const mark = gap >= GAP_MARK_MS ? fmt(f, "gap", { gap: gapText(gap) }) : "";
    if (mark.trim()) out.push({ role: "system", content: mark });
    if (engine === "claude" && inGrokScene(message)) {
      // One line for the whole stretch (a pause inside it still shows).
      const prev = out[out.length - 1];
      if (!(prev?.role === "system" && prev.content === fold) && fold.trim()) out.push({ role: "system", content: fold });
      return;
    }
    const images = message.role === "user" ? message.meta.images : undefined;
    const prev = out[out.length - 1];
    if (message.role === "user" && prev?.role === "user") {
      // Her pieces one after another are one message, a blank line between them, as his are (she asked, 10/4).
      out[out.length - 1] = {
        ...prev,
        content: `${prev.content}\n\n${modelFacingText(message, f)}`,
        ...(images?.length || prev.images?.length ? { images: [...(prev.images ?? []), ...(images ?? [])] } : {}),
      };
      return;
    }
    out.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: modelFacingText(message, f),
      ...(images?.length ? { images } : {}),
    });
  });
  if (nowMs != null) fellAsleep(rows[rows.length - 1], nowMs - (rows[rows.length - 1]?.createdAt ?? nowMs));
  return out;
}

export function voiceVars(parts: VoicePackParts, strip: VoiceStrip = "none"): Record<string, string> {
  const claude = parts.engine === "claude";
  const persona = !parts.routing ? parts.charter : claude ? (parts.charterClaude ?? "") : (parts.charterGrok ?? "");
  const inBed = Boolean(parts.routing) && !claude;
  return {
    system_prompt: persona.trim() || NEUTRAL_PERSONA,
    identity: inBed ? "" : parts.identity.trim(),
    us: strip === "none" ? parts.us.trim() : "",
    us_when: strip === "none" && parts.us.trim() ? (parts.usWhen ?? "") : "",
    recall: strip === "none" ? parts.recall.trim() : "",
    clock: parts.time.clock,
    last_said: parts.time.lastSaid,
    since_last: parts.time.sinceLast,
    inner: (claude ? parts.innerDaily : parts.inner).trim(),
    user_text: parts.userText,
    quiet: parts.first?.quiet ?? "",
  };
}

export function buildVoiceMessages(parts: VoicePackParts, strip: VoiceStrip = "none"): VoiceChatMessage[] {
  const variant = parts.first ? "first" : "main";
  const template = variantMessages(parsePromptBody("voice", parts.voiceTemplate), variant);
  const historyLimit = strip === "thin" ? Math.min(VOICE_THIN_HISTORY, parts.historyWindow) : parts.historyWindow;
  const engine = parts.engine ?? "grok";
  const talk = voiceHistoryMessages(parts.history, historyLimit, parts.formats, engine, parts.nowMs);
  const vars = voiceVars(parts, strip);
  // What she said just before this line in the same breath (her round) goes into the same message as it.
  const lead = !parts.first && talk[talk.length - 1]?.role === "user" && !talk[talk.length - 1]!.images?.length ? talk.pop()! : null;
  if (lead) vars.user_text = `${lead.content}\n\n${vars.user_text}`;
  let rendered = renderPromptMessages(template, vars, talk) as VoiceChatMessage[];
  if (strip === "thin") {
    // Persona, recent talk, her line (or the note that he may write first): the first system message, everything
    // that is not a system message, and the last message.
    const first = rendered.findIndex((message) => message.role === "system");
    const last = rendered.length - 1;
    rendered = rendered.filter((message, i) => message.role !== "system" || i === first || i === last);
  }
  if (parts.userImages?.length) {
    // Her photos go with her line, the last thing he is given.
    const at = rendered.map((message) => message.role).lastIndexOf("user");
    if (at >= 0) rendered[at] = { ...rendered[at]!, images: parts.userImages };
  }
  return placePersona(rendered, { placement: parts.personaPlacement, ack: parts.personaAck });
}

/**
 * 「第一条消息」: the first system message of the template (persona, identity, intimate side, his rules) is sent as
 * the first user message instead, and he answers it with her fixed line before the talk starts. Same words.
 */
export function placePersona<T extends { role: string; content: string }>(
  messages: T[],
  opts: { placement: "system" | "first_user"; ack: string },
): T[] {
  if (opts.placement !== "first_user") return messages;
  const head = messages.findIndex((message) => message.role === "system");
  if (head < 0) return messages;
  const persona = messages[head]!;
  const rest = messages.filter((_, i) => i !== head);
  const at = rest.findIndex((message) => message.role !== "system");
  // No talk at all (he writes first on an empty day): still before the last note.
  const index = at < 0 ? Math.max(0, rest.length - 1) : at;
  const block = [
    { ...persona, role: "user" },
    { ...persona, role: "assistant", content: opts.ack.trim() || "嗯。" },
  ] as T[];
  return [...rest.slice(0, index), ...block, ...rest.slice(index)];
}

/** The first system message as sent (persona and what comes with it), for size notes. */
export function systemCharter(parts: VoicePackParts): string {
  const first = variantMessages(parsePromptBody("voice", parts.voiceTemplate), "main").find(
    (message) => message.role === "system" && message.content.trim() !== "{history_messages}",
  );
  return fillParagraphs(first?.content ?? "", voiceVars(parts)).trim();
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
    system: systemCharter(parts).length,
    moment: parts.us.length,
    story: parts.recall.length,
    history: history.reduce((n, m) => n + m.content.length, 0),
    user: parts.userText.length,
  };
}

export function formatVoiceInputCharsLine(c: VoiceInputChars): string {
  return `chars system=${c.system} moment=${c.moment} story=${c.story} history=${c.history} user=${c.user}`;
}


import { DEFAULT_FORMATS, fmt, type Formats } from "./brain/prompts/formats.ts";
import type { ChatMessage, MessageKind } from "./types";

/**
 * What is known about a message besides its words (`qingran_messages.meta`). The words are `body`, nothing else.
 */
export type MessageMeta = {
  /** His reply: the line of hers it answers. */
  replyTo?: string;
  /** Her line with several replies: the page she picked. */
  activeReply?: string;
  /** She stopped him while he was saying it. */
  interrupted?: boolean;
  /** Old rows: a sound in the night that was not her voice (kept, not answered). */
  nightNoise?: boolean;
  /** Folded into his memory already. */
  scanned?: boolean;
  /** Old rows: a line he did not answer (not her voice). */
  unheard?: boolean;
  /** Photos she sent with it (qr_photos ids). */
  images?: string[];
  /** His reply: who wrote it (Claude or Grok, by the model she picked). */
  engine?: "claude" | "grok";
};

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** A meta value from the database (or an import), keeping only what is known. */
export function readMeta(raw: unknown): MessageMeta {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const m = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const meta: MessageMeta = {};
  if (str(m.replyTo)) meta.replyTo = str(m.replyTo);
  if (str(m.activeReply)) meta.activeReply = str(m.activeReply);
  if (m.interrupted === true) meta.interrupted = true;
  if (m.nightNoise === true) meta.nightNoise = true;
  if (m.scanned === true) meta.scanned = true;
  if (m.unheard === true) meta.unheard = true;
  if (m.engine === "claude" || m.engine === "grok") meta.engine = m.engine;
  if (Array.isArray(m.images)) {
    const images = m.images.filter((id): id is string => typeof id === "string" && id.length > 0);
    if (images.length) meta.images = images;
  }
  return meta;
}

/**
 * A stored row's words and meta. A row written by old code (a phone or tab still on the version before 2026-10-02)
 * can still have its facts as ⟦…⟧ marks in front of the words: they are read as meta here, the same as migration 0050.
 */
export function fromStored(body: unknown, rawMeta: unknown): { text: string; meta: MessageMeta } {
  const text = String(body ?? "");
  const meta = readMeta(rawMeta);
  if (!text.startsWith("⟦")) return { text, meta };
  const legacy = parseLegacyBody(text);
  return { text: legacy.text, meta: { ...legacy.meta, ...meta } };
}

/** What the page knows about a message, as it is stored. */
export function metaOfChat(msg: ChatMessage): MessageMeta {
  return readMeta({
    replyTo: msg.replyTo,
    activeReply: msg.activeReply,
    interrupted: msg.interrupted,
    nightNoise: msg.nightNoise,
    scanned: msg.scanned,
    unheard: msg.kind === "unheard" || undefined,
    images: msg.images,
  });
}

/** A stored message as the page shows it. */
export function chatFromRow(row: {
  id: string;
  role: string;
  body: string;
  created_at: number;
  kind?: string | null;
  meta?: unknown;
}): ChatMessage {
  const { text, meta } = fromStored(row.body, row.meta);
  const kindCol = row.kind ?? undefined;
  const kind: MessageKind | undefined =
    meta.unheard || kindCol === "unheard"
      ? "unheard"
      : kindCol === "say" || kindCol === "proactive" || kindCol === "system_notice"
        ? kindCol
        : undefined;
  return {
    id: String(row.id),
    role: row.role === "assistant" ? "assistant" : "user",
    text,
    createdAt: Number(row.created_at),
    kind,
    scanned: meta.scanned,
    replyTo: meta.replyTo,
    activeReply: meta.activeReply,
    interrupted: meta.interrupted,
    nightNoise: meta.nightNoise,
    images: meta.images,
  };
}

/** The 「照片」 line of 材料的写法, when she sent photos. */
export function photoNote(count: number, f: Formats = DEFAULT_FORMATS): string {
  return count ? fmt(f, "photo", { count }) : "";
}

/** A message as the models read it: her words (old rows may still carry 〔…〕 sound tags), with a note when she sent photos. */
export function modelFacingText(msg: { text: string; meta?: MessageMeta }, f: Formats = DEFAULT_FORMATS): string {
  return `${photoNote(msg.meta?.images?.length ?? 0, f)}${stripSoundTags(msg.text).trim()}`;
}

/** Old rows: 〔…〕 tags an earlier hearing wrote about how her voice sounded. */
export function stripSoundTags(text: string): string {
  return text.replace(/〔[^〕]*〕/g, "");
}

/**
 * A body from before 2026-10-02, when these facts were ⟦…⟧ marks in front of the words (old export files).
 * migrations/0050_message_meta.sql did the same once for the database.
 */
export function parseLegacyBody(body: string): { text: string; meta: MessageMeta } {
  let text = body;
  const raw: Record<string, unknown> = {};
  for (;;) {
    const hit = text.match(/^⟦([^⟧]*)⟧/);
    if (!hit) break;
    const tok = hit[1]!;
    if (tok.startsWith("选:")) raw.activeReply = tok.slice(2);
    else if (tok === "夜噪") raw.nightNoise = true;
    else if (tok === "断") raw.interrupted = true;
    else if (tok === "已扫") raw.scanned = true;
    else if (tok.startsWith("回:")) raw.replyTo = tok.slice(2);
    else if (tok === "未听") raw.unheard = true;
    else if (tok.startsWith("图:")) raw.images = tok.slice(2).split(",").filter(Boolean);
    else if (!tok.startsWith("听:") && !tok.startsWith("气:") && tok !== "走向" && tok !== "设定") break;
    text = text.slice(hit[0].length);
  }
  return { text, meta: readMeta(raw) };
}

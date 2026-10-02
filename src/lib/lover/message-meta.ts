import { parseAcousticTags, stripAcousticTags, type AcousticTags } from "./hearing/tags.ts";
import type { ChatMessage, MessageKind } from "./types";

/**
 * What is known about a message besides its words (`qingran_messages.meta`). The words are `body`, nothing else.
 */
export type MessageMeta = {
  /** His reply: the line of hers it answers. */
  replyTo?: string;
  /** Her line with several replies: the page she picked. */
  activeReply?: string;
  /** Her spoken line: the recording it came from. */
  voiceTurnId?: string;
  /** She confirmed what was heard. */
  hearingGold?: "confirmed";
  /** How her voice sounded, as the phone guessed: "length.contour.voice.events". */
  predicted?: string;
  /** She stopped him while he was saying it. */
  interrupted?: boolean;
  /** A sound in the night that was not her voice (kept, not answered). */
  nightNoise?: boolean;
  /** Folded into his memory already. */
  scanned?: boolean;
  /** A line he did not answer (not her voice). */
  unheard?: boolean;
  /** Photos she sent with it (qr_photos ids). */
  images?: string[];
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
  if (str(m.voiceTurnId)) meta.voiceTurnId = str(m.voiceTurnId);
  if (m.hearingGold === "confirmed") meta.hearingGold = "confirmed";
  if (str(m.predicted)) meta.predicted = str(m.predicted);
  if (m.interrupted === true) meta.interrupted = true;
  if (m.nightNoise === true) meta.nightNoise = true;
  if (m.scanned === true) meta.scanned = true;
  if (m.unheard === true) meta.unheard = true;
  if (Array.isArray(m.images)) {
    const images = m.images.filter((id): id is string => typeof id === "string" && id.length > 0);
    if (images.length) meta.images = images;
  }
  return meta;
}

function predictedOf(tags: AcousticTags | undefined): string | undefined {
  if (!tags) return undefined;
  return `${tags.length ?? ""}.${tags.contour ?? ""}.${tags.voice ?? ""}.${tags.events?.join("+") ?? ""}`;
}

function tagsOf(predicted: string | undefined): AcousticTags | undefined {
  if (!predicted) return undefined;
  const [length, contour, voice, event] = predicted.split(".");
  return parseAcousticTags({ length, contour, voice, event }) ?? undefined;
}

/** What the page knows about a message, as it is stored. */
export function metaOfChat(msg: ChatMessage): MessageMeta {
  return readMeta({
    replyTo: msg.replyTo,
    activeReply: msg.activeReply,
    voiceTurnId: msg.voiceTurnId,
    hearingGold: msg.voiceTurnId && msg.hearingGold === "confirmed" ? "confirmed" : undefined,
    predicted: predictedOf(msg.predictedTags),
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
  const meta = readMeta(row.meta);
  const kindCol = row.kind ?? undefined;
  const kind: MessageKind | undefined = meta.unheard
    ? "unheard"
    : kindCol === "say" || kindCol === "proactive" || kindCol === "system_notice"
      ? kindCol
      : undefined;
  return {
    id: String(row.id),
    role: row.role === "assistant" ? "assistant" : "user",
    text: String(row.body ?? ""),
    createdAt: Number(row.created_at),
    kind,
    scanned: meta.scanned,
    voiceTurnId: meta.voiceTurnId,
    hearingGold: meta.voiceTurnId ? (meta.hearingGold ?? "unconfirmed") : undefined,
    replyTo: meta.replyTo,
    activeReply: meta.activeReply,
    predictedTags: tagsOf(meta.predicted),
    interrupted: meta.interrupted,
    nightNoise: meta.nightNoise,
    images: meta.images,
  };
}

/** What the words say about photos she sent with them (the model may also see the photos themselves). */
export function photoNote(count: number): string {
  if (!count) return "";
  return count === 1 ? "（发来一张照片）" : `（发来 ${count} 张照片）`;
}

/** A message as the models read it: her words without hearing marks, with a note when she sent photos. */
export function modelFacingText(msg: { text: string; meta?: MessageMeta }): string {
  return `${photoNote(msg.meta?.images?.length ?? 0)}${stripAcousticTags(msg.text).trim()}`;
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
    else if (tok.startsWith("听:") && tok.endsWith(":金")) {
      raw.voiceTurnId = tok.slice(2, -2);
      raw.hearingGold = "confirmed";
    } else if (tok.startsWith("听:")) raw.voiceTurnId = tok.slice(2);
    else if (tok.startsWith("气:")) raw.predicted = tok.slice(2);
    else if (tok.startsWith("回:")) raw.replyTo = tok.slice(2);
    else if (tok === "未听") raw.unheard = true;
    else if (tok.startsWith("图:")) raw.images = tok.slice(2).split(",").filter(Boolean);
    else if (tok !== "走向" && tok !== "设定") break;
    text = text.slice(hit[0].length);
  }
  return { text, meta: readMeta(raw) };
}

import { parseAcousticTags, stripAcousticTags, type AcousticTags } from "./hearing/tags.ts";
import type { ChatMessage, MessageKind } from "./types";

export function encodeStoredMessage(msg: ChatMessage): string {
  let text = msg.text;
  if (msg.images?.length) text = `⟦图:${msg.images.join(",")}⟧${text}`;
  if (msg.kind === "unheard") text = `⟦未听⟧${text}`;
  if (msg.replyTo) text = `⟦回:${msg.replyTo}⟧${text}`;
  if (msg.predictedTags) {
    const events = msg.predictedTags.events?.join("+") ?? "";
    text = `⟦气:${msg.predictedTags.length ?? ""}.${msg.predictedTags.contour ?? ""}.${msg.predictedTags.voice ?? ""}.${events}⟧${text}`;
  }
  if (msg.voiceTurnId) {
    text =
      msg.hearingGold === "confirmed"
        ? `⟦听:${msg.voiceTurnId}:金⟧${text}`
        : `⟦听:${msg.voiceTurnId}⟧${text}`;
  }
  if (msg.scanned) text = `⟦已扫⟧${text}`;
  if (msg.interrupted) text = `⟦断⟧${text}`;
  if (msg.nightNoise) text = `⟦夜噪⟧${text}`;
  if (msg.activeReply) text = `⟦选:${msg.activeReply}⟧${text}`;
  return text;
}

export function decodeStoredBody(body: string, kindCol?: string): {
  text: string;
  scanned: boolean;
  kind: MessageKind | undefined;
  voiceTurnId?: string;
  hearingGold?: ChatMessage["hearingGold"];
  replyTo?: string;
  activeReply?: string;
  predictedTags?: AcousticTags;
  interrupted: boolean;
  nightNoise: boolean;
  images?: string[];
} {
  let text = body;
  let scanned = false;
  let kind: MessageKind | undefined =
    kindCol === "say" ||
    kindCol === "unheard" ||
    kindCol === "proactive" ||
    kindCol === "system_notice"
      ? kindCol
      : undefined;
  let voiceTurnId: string | undefined;
  let hearingGold: ChatMessage["hearingGold"];
  let replyTo: string | undefined;
  let activeReply: string | undefined;
  let predictedTags: AcousticTags | undefined;
  let interrupted = false;
  let nightNoise = false;
  const picked = text.match(/^⟦选:([^⟧]+)⟧/);
  if (picked) {
    activeReply = picked[1];
    text = text.slice(picked[0].length);
  }
  if (text.startsWith("⟦夜噪⟧")) {
    nightNoise = true;
    text = text.slice("⟦夜噪⟧".length);
  }
  if (text.startsWith("⟦断⟧")) {
    interrupted = true;
    text = text.slice("⟦断⟧".length);
  }
  if (text.startsWith("⟦已扫⟧")) {
    scanned = true;
    text = text.slice(4);
  }
  const hear = text.match(/^⟦听:([^⟧]+)⟧/);
  if (hear) {
    const raw = hear[1]!;
    if (raw.endsWith(":金")) {
      voiceTurnId = raw.slice(0, -2);
      hearingGold = "confirmed";
    } else {
      voiceTurnId = raw;
      hearingGold = "unconfirmed";
    }
    text = text.slice(hear[0].length);
  }
  const gas = text.match(/^⟦气:([^⟧]+)⟧/);
  if (gas) {
    const [length, contour, voice, event] = gas[1]!.split(".");
    predictedTags = parseAcousticTags({ length, contour, voice, event }) ?? undefined;
    text = text.slice(gas[0].length);
  }
  const reply = text.match(/^⟦回:([^⟧]+)⟧/);
  if (reply) {
    replyTo = reply[1];
    text = text.slice(reply[0].length);
  }
  if (text.startsWith("⟦未听⟧")) {
    kind = "unheard";
    text = text.slice(4);
  }
  let images: string[] | undefined;
  const photos = text.match(/^⟦图:([^⟧]*)⟧/);
  if (photos) {
    images = photos[1]!.split(",").filter(Boolean);
    text = text.slice(photos[0].length);
  }
  return { text, scanned, kind, voiceTurnId, hearingGold, replyTo, activeReply, predictedTags, interrupted, nightNoise, images };
}

/** Keep stored prefixes (hearing, chosen reply, …) and replace only the visible words. */
export function mergeEditedUserBody(existing: string | undefined, plain: string): string {
  const next = plain.trim();
  if (!existing) return next;
  if (!next) return existing;
  const decoded = decodeStoredBody(existing);
  if (decoded.text === next) return existing;
  if (existing.endsWith(decoded.text)) {
    return existing.slice(0, existing.length - decoded.text.length) + next;
  }
  return existing;
}

export function isNightNoiseBody(body: string): boolean {
  return body.includes("⟦夜噪⟧");
}

/** What the words say about photos she sent with them (the model may also see the photos themselves). */
export function photoNote(count: number): string {
  if (!count) return "";
  return count === 1 ? "（发来一张照片）" : `（发来 ${count} 张照片）`;
}

export function modelFacingText(body: string): string {
  const decoded = decodeStoredBody(body);
  return `${photoNote(decoded.images?.length ?? 0)}${stripAcousticTags(decoded.text).trim()}`;
}

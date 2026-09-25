import { parseAcousticTags, stripAcousticTags, type AcousticTags } from "./hearing/tags.ts";
import type { ChatMessage, MessageKind } from "./types";

export function encodeStoredMessage(msg: ChatMessage): string {
  let text = msg.text;
  if (msg.kind === "steer") text = `⟦走向⟧${text}`;
  else if (msg.kind === "setting") text = `⟦设定⟧${text}`;
  else if (msg.kind === "unheard") text = `⟦未听⟧${text}`;
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
} {
  let text = body;
  let scanned = false;
  let kind: MessageKind | undefined =
    kindCol === "steer" ||
    kindCol === "setting" ||
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
  if (text.startsWith("⟦走向⟧")) {
    kind = "steer";
    text = text.slice(4);
  } else if (text.startsWith("⟦设定⟧")) {
    kind = "setting";
    text = text.slice(4);
  } else if (text.startsWith("⟦未听⟧")) {
    kind = "unheard";
    text = text.slice(4);
  }
  return { text, scanned, kind, voiceTurnId, hearingGold, replyTo, activeReply, predictedTags, interrupted, nightNoise };
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

export function modelFacingText(body: string): string {
  return stripAcousticTags(decodeStoredBody(body).text).trim();
}

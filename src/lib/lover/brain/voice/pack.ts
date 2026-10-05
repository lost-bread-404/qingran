import { timeFacts } from "../heart.ts";
import { photoNote } from "../../message-meta.ts";
import { NEUTRAL_PERSONA, personaText, voiceInjectFromProfile, type Profile, type VoiceInjectFlags } from "../../types.ts";
import { rememberBlock, rememberCharter, type VoiceRefs } from "../log-refs.ts";
import { getMessage, getMeta, listHistoryWindow, upsertMessage } from "../store.ts";
import type { StoredMessage, VoiceChatMessage } from "../types.ts";
import { loadFormats, loadPrompt } from "../prompts/store.ts";
import { getDossier } from "../dossier.ts";
import { agoText, dateClockText } from "../time.ts";
import { fmt } from "../prompts/formats.ts";
import { recentInner } from "../memory.ts";
import { dayStart } from "../sleep.ts";
import { buildVoiceMessages, voiceInputChars, type VoiceInputChars, type VoicePackParts } from "./pack-build.ts";

export type HotContext = {
  messages: VoiceChatMessage[];
  packMs: number;
  dbFirstMs: number;
  sessionId: string | null;
  user: StoredMessage;
  charterHash: string;
  longtermHash: string;
  historyIds: string[];
  clockText: string;
  timeZone: string;
  refs: VoiceRefs;
  parts: VoicePackParts;
  inputChars: VoiceInputChars;
  promptKey: string;
  promptHash: string;
  inject: VoiceInjectFlags;
  personaPlacement: "system" | "first_user";
};

/** A safety cap on the talk the reply is given (a very long day); the newest are kept. */
export const TODAY_MAX = 400;

/**
 * The talk the reply sees (v7): her whole day, from the first message after she last slept, or from 清空聊天 if that
 * came later. Context is his brain; there is no memory library to fold it into.
 */
export async function replyHistory(
  excludeId: string | null,
  nowMs: number,
  timeZone: string,
  opts: { replyId?: string } = {},
): Promise<StoredMessage[]> {
  const [all, meta, start] = await Promise.all([listHistoryWindow(excludeId, TODAY_MAX + 1), getMeta(), dayStart(nowMs, timeZone)]);
  // An answer to an earlier part of her round that she never heard (she went on) is not part of the talk.
  const rows = opts.replyId ? all.filter((m) => m.id !== opts.replyId) : all;
  const from = Math.max(start, Number(meta.contextFrom) || 0);
  return rows.filter((m) => m.createdAt >= from).slice(-TODAY_MAX);
}

/** Everything the reply needs, read before the model is called (no model call here). */
export async function loadHotContext(input: {
  text: string;
  userMsgId: string;
  userCreatedAt: number;
  profile: Profile;
  nowMs: number;
  timeZone: string;
  /** Photos she sent with this line (also in the stored meta; sent along so a slow save does not lose them). */
  images?: string[];
  replyId?: string;
}): Promise<HotContext> {
  const t0 = Date.now();
  const userExisting = await getMessage(input.userMsgId);
  const dbFirstMs = Date.now() - t0;
  const images = input.images?.length ? input.images : (userExisting?.meta.images ?? []);
  const user = await upsertMessage({
    id: input.userMsgId,
    role: "user",
    // Her words as sent now (a photo with no words keeps what is there); what else is known about it stays.
    text: input.text.trim() || userExisting?.text || "",
    meta: images.length ? { images } : {},
    createdAt: userExisting?.createdAt || input.userCreatedAt || input.nowMs,
    kind: userExisting?.kind,
    timeZone: input.timeZone,
  });

  // Memory off → persona + context only.
  const inject = voiceInjectFromProfile(input.profile);
  const { parts, voicePrompt } = await gatherVoiceParts({
    profile: input.profile,
    nowMs: input.nowMs,
    timeZone: input.timeZone,
    history: replyHistory(input.userMsgId, input.nowMs, input.timeZone, { replyId: input.replyId }),
    userText: input.text,
    images,
    lastSaidBefore: input.userCreatedAt,
  });
  const history = parts.history;
  const charter = input.profile.systemPrompt;
  const us = parts.us;
  const clockText = parts.time.clock;
  const [charterHash, longtermHash] = await Promise.all([
    rememberCharter(
      personaText(input.profile, charter).trim() || NEUTRAL_PERSONA,
    ),
    rememberBlock("voice_longterm", us),
  ]);
  const historyIds = history.map((m) => m.id);
  const refs: VoiceRefs = {
    charterHash,
    longtermHash,
    historyIds,
    personaPlacement: input.profile.personaPlacement,
    clockText,
    userMsgId: input.userMsgId,
    timeZone: input.timeZone,
    injectMemory: inject.memory,
    historyWindow: inject.history,
  };

  return {
    messages: buildVoiceMessages(parts, "none"),
    packMs: Date.now() - t0,
    dbFirstMs,
    sessionId: user.sessionId,
    user,
    charterHash,
    longtermHash,
    historyIds,
    clockText,
    timeZone: input.timeZone,
    refs,
    parts,
    inputChars: voiceInputChars(parts),
    promptKey: voicePrompt.key,
    promptHash: voicePrompt.hash,
    inject,
    personaPlacement: input.profile.personaPlacement,
  };
}

/**
 * Everything the voice template is filled with, the same for a reply, a message he starts himself, a replay and the
 * preview: what she wrote (persona, 亲密设定, 身份), 现在的你们, what comes back to him, the time, his ｛｝ notes.
 * Only data here; every word around it is in the template (指令 → 每轮回复) and 材料的写法.
 */
export async function gatherVoiceParts(input: {
  profile: Profile;
  nowMs: number;
  timeZone: string;
  /** The talk he is given (a promise is read alongside everything else). */
  history: StoredMessage[] | Promise<StoredMessage[]>;
  userText: string;
  images?: string[];
  /** Set when he may write first: no line of hers, and how long she has been quiet instead of when she last spoke. */
  first?: { quiet: string };
  /** Her line's time: 「上一次说话」 is the one before it. */
  lastSaidBefore?: number;
  /** Replay's other side: another persona. */
  charter?: string;
  placement?: Profile["personaPlacement"];
}): Promise<{ parts: VoicePackParts; voicePrompt: Awaited<ReturnType<typeof loadPrompt>> }> {
  const inject = voiceInjectFromProfile(input.profile);
  const [history, us, time, inner, voicePrompt, formats, start] = await Promise.all([
    input.history,
    inject.memory ? getDossier() : Promise.resolve(null),
    timeFacts(input.nowMs, input.timeZone, input.lastSaidBefore ?? input.nowMs, { sinceLast: !input.first }),
    recentInner(input.nowMs),
    loadPrompt("voice"),
    loadFormats(),
    dayStart(input.nowMs, input.timeZone),
  ]);
  const images = input.images ?? [];
  // Only what he wrote in ｛｝ today (since she last slept); nothing at all when there is none.
  const innerText = inner
    .filter((n) => n.at >= start)
    .map((n) => fmt(formats, "innerLine", { when: agoText(n.at, input.nowMs, input.timeZone), body: n.body }))
    .join("\n");
  const persona = personaText(input.profile, input.charter ?? input.profile.systemPrompt);
  const parts: VoicePackParts = {
    charter: persona,
    intimate: input.profile.intimateNotes,
    identity: input.profile.identity,
    us: us?.body.trim() ?? "",
    time,
    inner: innerText,
    usWhen: us?.body.trim() && us.updatedAt ? dateClockText(us.updatedAt, input.timeZone) : "",
    maxChars: input.profile.replyMaxChars,
    formats,
    history,
    historyWindow: history.length,
    userText: `${photoNote(images.length, formats)}${input.userText}`,
    userImages: images,
    first: input.first,
    voiceTemplate: voicePrompt.body,
    personaPlacement: input.placement ?? input.profile.personaPlacement,
    personaAck: input.profile.personaAck,
  };
  return { parts, voicePrompt };
}

import { timeFacts, dayWindow } from "../heart.ts";
import { modelFacingText, photoNote } from "../../message-meta.ts";
import { NEUTRAL_PERSONA, charterText, voiceInjectFromProfile, type Profile, type VoiceInjectFlags } from "../../types.ts";
import { rememberBlock, rememberCharter, type VoiceRefs } from "../log-refs.ts";
import { getMessage, getMeta, listHistoryWindow, upsertMessage } from "../store.ts";
import { enqueue } from "../jobs.ts";
import type { StoredMessage, VoiceChatMessage } from "../types.ts";
import { loadFormats, loadPrompt } from "../prompts/store.ts";
import { localDay } from "../time.ts";
import { getDossier } from "../dossier.ts";
import { agoText, dateClockText } from "../time.ts";
import { fmt } from "../prompts/formats.ts";
import { recentlyRecalled, recall, recallText, recentInner, type Memory } from "../memory.ts";
import { LEAD, castOf, splitSpeakers, type Cast } from "../../cast.ts";
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
  /** The moments that came back to him for this line, and whether they were found by meaning or by words. */
  recalled: Memory[];
  recallBy: string;
  personaPlacement: "system" | "first_user";
};

/** The most the reply is given of today's talk. Past this, the talk so far is folded into his memory. */
export const TODAY_MAX = 200;
/** After a fold, the reply starts again from this many of the last messages, and grows from there. */
export const KEEP_AFTER_FOLD = 20;

/**
 * The talk the reply sees: everything since 04:00 today, and at least `min` messages (so a new morning still has
 * last night). Context is his brain. When today's talk grows past TODAY_MAX (`fold`: the reply, with memory on),
 * everything so far is folded into his memory right away (a night pass on the day so far); until that is done he
 * still gets the last TODAY_MAX, after it he gets the last KEEP_AFTER_FOLD from the fold on (requirements 第 4 节).
 */
export async function replyHistory(
  excludeId: string | null,
  min: number,
  nowMs: number,
  timeZone: string,
  opts: { fold?: boolean; replyId?: string } = {},
): Promise<StoredMessage[]> {
  const day = localDay(nowMs, timeZone);
  const from = dayWindow(day, timeZone).from;
  const [all, meta] = await Promise.all([listHistoryWindow(excludeId, TODAY_MAX + 1), getMeta()]);
  // An answer to an earlier part of her round that she never heard (she went on) is not part of the talk.
  const rows = opts.replyId ? all.filter((m) => m.id !== opts.replyId) : all;
  const cut = Number(meta.contextFrom) || 0;
  let start: number;
  if (cut > from) {
    const at = rows.findIndex((m) => m.createdAt >= cut);
    start = at < 0 ? rows.length : at;
  } else {
    const firstToday = rows.findIndex((m) => m.createdAt >= from);
    start = Math.min(firstToday < 0 ? rows.length : firstToday, Math.max(0, rows.length - min));
  }
  const talk = rows.slice(start);
  if (talk.length <= TODAY_MAX) return talk;
  const shown = talk.slice(-TODAY_MAX);
  if (opts.fold) {
    const keepFrom = shown[shown.length - KEEP_AFTER_FOLD]?.createdAt ?? nowMs;
    // One fold per stretch of talk (keyed by where this stretch began).
    await enqueue("night", `fold:${day}:${cut}`, { day, upto: nowMs, keepFrom }).catch((err) => console.error(err));
  }
  return shown;
}

/** How far back a 「名字：」 block still means that person is in the scene. */
const SCENE_LOOKBACK = 8;

/**
 * Who else is in the scene now: anyone with his own 「名字：」 block in the last few replies. Their memories that
 * 清然 does not share (`knows`) can come back while they are here; with 清然 alone they never do.
 */
export function scenePresent(history: StoredMessage[], cast: Cast): string[] {
  const names = new Set<string>();
  for (const m of history.slice(-SCENE_LOOKBACK)) {
    if (m.role !== "assistant") continue;
    for (const part of splitSpeakers(modelFacingText(m), cast)) if (part.who !== LEAD) names.add(part.who);
  }
  return [...names];
}

/** What she is talking about now: her line (weighted), and the few lines before it. */
export function recallQuery(text: string, history: StoredMessage[]): string {
  const before = history.slice(-3).map((m) => modelFacingText(m));
  return [text, text, ...before].filter((line) => line.trim()).join("\n");
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
  const { parts, recalled, voicePrompt } = await gatherVoiceParts({
    profile: input.profile,
    nowMs: input.nowMs,
    timeZone: input.timeZone,
    history: replyHistory(input.userMsgId, inject.history, input.nowMs, input.timeZone, {
      fold: inject.memory,
      replyId: input.replyId,
    }),
    userText: input.text,
    images,
    lastSaidBefore: input.userCreatedAt,
  });
  const history = parts.history;
  const charter = input.profile.systemPrompt;
  const us = parts.us;
  const clockText = parts.time.clock;
  const [charterHash, longtermHash] = await Promise.all([
    rememberCharter([charterText(input.profile, charter).trim() || NEUTRAL_PERSONA, input.profile.intimateNotes.trim()].filter(Boolean).join("\n\n")),
    rememberBlock("voice_longterm", us),
  ]);
  const historyIds = history.map((m) => m.id);
  const refs: VoiceRefs = {
    charterHash,
    longtermHash,
    historyIds,
    pickedIds: recalled.memories.map((m) => String(m.id)),
    recallBy: recalled.by,
    recalled: recalled.memories.map((m) => m.body.slice(0, 200)),
    personaPlacement: input.profile.personaPlacement,
    queryScores: recalled.scores,
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
    recalled: recalled.memories,
    recallBy: recalled.by,
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
}): Promise<{ parts: VoicePackParts; recalled: Awaited<ReturnType<typeof recall>>; voicePrompt: Awaited<ReturnType<typeof loadPrompt>> }> {
  const inject = voiceInjectFromProfile(input.profile);
  const [history, us, time, inner, voicePrompt, formats, claudePrompt] = await Promise.all([
    input.history,
    inject.memory ? getDossier() : Promise.resolve(null),
    timeFacts(input.nowMs, input.timeZone, input.lastSaidBefore ?? input.nowMs, { sinceLast: !input.first }),
    recentInner(input.nowMs),
    loadPrompt("voice"),
    loadFormats(),
    loadPrompt("claude"),
  ]);
  const recalled = inject.memory
    ? await recall(recallQuery(input.userText, history), input.nowMs, {
        present: scenePresent(history, castOf(input.profile)),
        skip: await recentlyRecalled(input.nowMs).catch(() => undefined),
      })
    : { memories: [], scores: [], by: "none" as const };
  const images = input.images ?? [];
  const parts: VoicePackParts = {
    charter: charterText(input.profile, input.charter ?? input.profile.systemPrompt),
    intimate: input.profile.intimateNotes,
    identity: input.profile.identity,
    us: us?.body.trim() ?? "",
    recall: recallText(recalled.memories, formats),
    time,
    // Each note with when he wrote it: 「今晚……」 from last night is then read as last night.
    inner: inner.map((n) => fmt(formats, "innerLine", { when: agoText(n.at, input.nowMs, input.timeZone), body: n.body })).join("\n"),
    innerDaily: inner
      .filter((n) => !n.grok)
      .map((n) => fmt(formats, "innerLine", { when: agoText(n.at, input.nowMs, input.timeZone), body: n.body }))
      .join("\n"),
    usWhen: us?.body.trim() && us.updatedAt ? dateClockText(us.updatedAt, input.timeZone) : "",
    formats,
    history,
    historyWindow: history.length,
    nowMs: input.nowMs,
    userText: `${photoNote(images.length, formats)}${input.userText}`,
    userImages: images,
    first: input.first,
    voiceTemplate: voicePrompt.body,
    claudeTemplate: claudePrompt.body,
    personaPlacement: input.placement ?? input.profile.personaPlacement,
    personaAck: input.profile.personaAck,
  };
  return { parts, recalled, voicePrompt };
}

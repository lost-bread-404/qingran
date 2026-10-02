import { timeFacts, dayWindow } from "../heart.ts";
import { mergeEditedUserBody, modelFacingText } from "../../message-markup.ts";
import { NEUTRAL_PERSONA, personaText, voiceInjectFromProfile, type Profile, type VoiceInjectFlags } from "../../types.ts";
import { rememberBlock, rememberCharter, type VoiceRefs } from "../log-refs.ts";
import { getMessage, listHistoryWindow, upsertMessage } from "../store.ts";
import type { StoredMessage, VoiceChatMessage } from "../types.ts";
import { loadPrompt } from "../prompts/store.ts";
import { identityBlock } from "../life.ts";
import { localDay } from "../time.ts";
import { dossierTextForModel } from "../dossier.ts";
import { recall, recallText, recentInner, type Memory } from "../memory.ts";
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

/** The most the reply is given of today's talk, however long the day has been. */
const TODAY_MAX = 200;

/**
 * The talk the reply sees: everything since 04:00 today, and at least `min` messages (so a new morning still has
 * last night). Context is his brain; the day's talk is short enough to give whole.
 */
export async function replyHistory(
  excludeId: string | null,
  min: number,
  nowMs: number,
  timeZone: string,
  replyId?: string,
): Promise<StoredMessage[]> {
  const from = dayWindow(localDay(nowMs, timeZone), timeZone).from;
  // An answer to an earlier part of her round that she never heard (she went on) is not part of the talk.
  const rows = (await listHistoryWindow(excludeId, TODAY_MAX)).filter((m) => m.id !== replyId);
  const firstToday = rows.findIndex((m) => m.createdAt >= from);
  const start = Math.min(firstToday < 0 ? rows.length : firstToday, Math.max(0, rows.length - min));
  return rows.slice(start);
}

/** What she is talking about now: her line (weighted), and the few lines before it. */
export function recallQuery(text: string, history: StoredMessage[]): string {
  const before = history.slice(-3).map((m) => modelFacingText(m.text));
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
  replyId?: string;
}): Promise<HotContext> {
  const t0 = Date.now();
  const userExisting = await getMessage(input.userMsgId);
  const dbFirstMs = Date.now() - t0;
  const user = await upsertMessage({
    id: input.userMsgId,
    role: "user",
    text: mergeEditedUserBody(userExisting?.text, input.text),
    createdAt: userExisting?.createdAt || input.userCreatedAt || input.nowMs,
    kind: userExisting?.kind,
    timeZone: input.timeZone,
  });

  // Memory off → persona + context only.
  const inject = voiceInjectFromProfile(input.profile);
  const [history, us, clockText, voicePrompt] = await Promise.all([
    replyHistory(input.userMsgId, inject.history, input.nowMs, input.timeZone, input.replyId),
    inject.memory ? dossierTextForModel() : Promise.resolve(""),
    timeFacts(input.nowMs, input.timeZone, input.userCreatedAt),
    loadPrompt("voice"),
  ]);
  const recalled = inject.memory ? await recall(recallQuery(input.text, history), input.nowMs) : { memories: [], scores: [], by: "none" as const };
  const clockWithInner = withInner(clockText, await recentInner(input.nowMs));
  const charter = personaText(input.profile);
  const parts: VoicePackParts = {
    charter,
    identity: identityBlock(input.profile.identity),
    us,
    recall: recallText(recalled.memories),
    clock: clockWithInner,
    history,
    historyWindow: history.length,
    userText: input.text,
    voiceTemplate: voicePrompt.body,
    personaPlacement: input.profile.personaPlacement,
    personaAck: input.profile.personaAck,
  };
  const [charterHash, longtermHash] = await Promise.all([
    rememberCharter(charter.trim() || NEUTRAL_PERSONA),
    rememberBlock("voice_longterm", us),
  ]);
  const historyIds = history.map((m) => m.id);
  const refs: VoiceRefs = {
    charterHash,
    longtermHash,
    historyIds,
    pickedIds: recalled.memories.map((m) => String(m.id)),
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

/** His own ｛｝ notes from the last 16 hours sit right under the clock, so he answers by what he decided. */
export function withInner(clockText: string, inner: string): string {
  return inner ? `${clockText}\n你心里记着、Rosie 看不到的：\n${inner}` : clockText;
}

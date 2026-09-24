import { mergeEditedUserBody } from "../../message-markup.ts";
import { voiceInjectFromProfile, type Profile, type VoiceInjectFlags } from "../../types.ts";
import { SESSION_GAP_MS } from "../config.ts";
import { rememberBlock, rememberCharter, type VoiceRefs } from "../log-refs.ts";
import {
  getMessage,
  getMeta,
  getMind,
  listHistoryWindow,
  listNotes,
  listNotesByIds,
  listPortrait,
  upsertMessage,
} from "../store.ts";
import { formatClock } from "../time.ts";
import type { StoredMessage, VoiceChatMessage } from "../types.ts";
import { EMPTY_MIND } from "../types.ts";
import { pickHotNotes } from "./retrieve.ts";
import { loadPrompt } from "../prompts/store.ts";
import { ensureMemoryHygiene } from "../memory-hygiene.ts";
import {
  buildTail,
  formatMemories,
  renderVoiceLongterm,
  voiceFacingSlots,
  voiceInputChars,
  voiceMessagesForStrip,
  type VoiceInputChars,
  type VoicePackParts,
} from "./pack-build.ts";

export {
  buildTail,
  buildVoiceMessages,
  renderVoiceLongterm,
  voiceInputChars,
  voiceMessagesForStrip,
} from "./pack-build.ts";
export type { VoiceInputChars, VoicePackParts, VoiceStrip } from "./pack-build.ts";

export type HotContext = {
  messages: VoiceChatMessage[];
  packMs: number;
  dbFirstMs: number;
  sessionId: string | null;
  user: StoredMessage;
  tail: string;
  mindTurnSeq: number;
  mindAgeMs: number;
  mindStale: boolean;
  pickedIds: string[];
  fallbackIds: string[];
  queryIds: string[];
  queryScores: number[];
  jump: boolean;
  jumpScore: number;
  careHint: boolean;
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
};

export async function loadHotContext(input: {
  text: string;
  userMsgId: string;
  userCreatedAt: number;
  profile: Profile;
  nowMs: number;
  timeZone: string;
}): Promise<HotContext> {
  const t0 = Date.now();
  let dbFirstMs = 0;
  const markFirst = () => {
    if (!dbFirstMs) dbFirstMs = Date.now() - t0;
  };
  const userExisting = await getMessage(input.userMsgId);
  markFirst();
  const user = await upsertMessage({
    id: input.userMsgId,
    role: "user",
    text: mergeEditedUserBody(userExisting?.text, input.text),
    createdAt: userExisting?.createdAt || input.userCreatedAt || input.nowMs,
    kind: userExisting?.kind,
    timeZone: input.timeZone,
  });
  await ensureMemoryHygiene();

  const inject = voiceInjectFromProfile(input.profile);
  const [history, mind, portrait, meta] = await Promise.all([
    listHistoryWindow(input.userMsgId, inject.history),
    getMind(),
    listPortrait(),
    getMeta(),
  ]);

  const liveMind = mind.turn_seq ? mind : EMPTY_MIND;
  const mindAgeMs = liveMind.updated_at ? input.nowMs - liveMind.updated_at : 0;
  const mindStale = Boolean(liveMind.updated_at) && mindAgeMs > SESSION_GAP_MS;
  const injectMind = input.profile.injectMind !== false;
  const tailMind = !injectMind || mindStale || !liveMind.insight.trim() ? EMPTY_MIND : liveMind;
  const picked = await pickHotNotes(
    !injectMind || mindStale ? [] : mind.memory_ids ?? [],
    input.text,
    { minTerms: input.profile.retrieveMinTerms },
  );
  const notes = picked.notes;
  const pickedIds = picked.mindIds;
  const fallbackIds: string[] = [];
  const careHint = false;

  const clockText = formatClock(input.nowMs, input.timeZone);
  const tail = buildTail({
    clock: clockText,
    mind: tailMind,
    notes,
    timeZone: input.timeZone,
    careHint,
    nowMs: input.nowMs,
    stale: false,
    jump: false,
    inject,
  });

  const longterm = renderVoiceLongterm(meta.selfSummary, meta.bondSummary, portrait);
  const charter = input.profile.systemPrompt;
  const loaded = await loadPrompt("voice");
  const parts: VoicePackParts = {
    charter,
    longterm,
    history,
    userText: input.text,
    mind: tailMind,
    notes,
    clockText,
    timeZone: input.timeZone,
    careHint,
    nowMs: input.nowMs,
    mindStale,
    jump: false,
    voiceTemplate: loaded.body,
    selfSummary: meta.selfSummary,
    bondSummary: meta.bondSummary,
    portrait,
    injectMemories: inject.memories,
    injectLongterm: inject.longterm,
    historyWindow: inject.history,
  };
  const [charterHash, longtermHash] = await Promise.all([
    rememberCharter(charter.trim() || "你就是清然。正在和 Rosie 语音通话。"),
    rememberBlock("voice_longterm", longterm),
  ]);

  const messages = voiceMessagesForStrip(parts, "none");
  const inputChars = voiceInputChars(parts);

  const historyIds = history.map((m) => m.id);
  const refs: VoiceRefs = {
    charterHash,
    longtermHash,
    historyIds,
    mindTurnSeq: liveMind.turn_seq,
    mindStale,
    pickedIds,
    fallbackIds,
    queryIds: picked.queryIds,
    queryScores: picked.queryScores,
    jump: false,
    jumpScore: 0,
    careHint,
    clockText,
    userMsgId: input.userMsgId,
    timeZone: input.timeZone,
    mindAgeMs,
    injectMemories: inject.memories,
    injectLongterm: inject.longterm,
    historyWindow: inject.history,
  };

  return {
    messages,
    packMs: Date.now() - t0,
    dbFirstMs,
    sessionId: user.sessionId,
    user,
    tail,
    mindTurnSeq: liveMind.turn_seq,
    mindAgeMs,
    mindStale,
    pickedIds,
    fallbackIds,
    queryIds: picked.queryIds,
    queryScores: picked.queryScores,
    jump: false,
    jumpScore: 0,
    careHint,
    charterHash,
    longtermHash,
    historyIds,
    clockText,
    timeZone: input.timeZone,
    refs,
    parts,
    inputChars,
    promptKey: loaded.key,
    promptHash: loaded.hash,
    inject,
  };
}

/** What the reply model would see for the five slots. Does not write or bump recall. */
export async function loadVoicePerspective(): Promise<{
  self: string;
  bond: string;
  portrait: string;
  mind: string;
  memories: string;
}> {
  const [meta, portrait, mind] = await Promise.all([getMeta(), listPortrait(), getMind()]);
  const ids = mind.memory_ids ?? [];
  let notes = ids.length ? (await listNotesByIds(ids)).filter((note) => note.status === "active") : [];
  if (!notes.length) notes = await listNotes({ status: "active", limit: 6 });
  const slots = voiceFacingSlots({
    selfSummary: meta.selfSummary,
    bondSummary: meta.bondSummary,
    portrait,
    mind: mind.insight,
    memories: formatMemories(notes, meta.timeZone || "UTC"),
  });
  return {
    self: slots.self,
    bond: slots.bond,
    portrait: slots.portrait,
    mind: slots.mind || "（还没有。回复里不会放【内心】）",
    memories: slots.memories,
  };
}

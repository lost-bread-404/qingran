import type { Profile } from "../../types.ts";
import { HISTORY_WINDOW, SESSION_GAP_MS } from "../config.ts";
import { rememberBlock, rememberCharter, type VoiceRefs } from "../log-refs.ts";
import {
  getDay,
  getMessage,
  getMeta,
  getMind,
  listHistoryWindow,
  listPortrait,
  upsertMessage,
} from "../store.ts";
import { formatClock, localDay } from "../time.ts";
import type { StoredMessage, VoiceChatMessage } from "../types.ts";
import { EMPTY_MIND } from "../types.ts";
import { pickHotNotes } from "./retrieve.ts";
import { topicJump } from "./jump.ts";
import {
  buildTail,
  renderVoiceLongterm,
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
    text: userExisting?.text || input.text,
    createdAt: userExisting?.createdAt || input.userCreatedAt || input.nowMs,
    kind: userExisting?.kind,
    timeZone: input.timeZone,
  });

  const [history, mind, portrait, meta] = await Promise.all([
    listHistoryWindow(input.userMsgId, HISTORY_WINDOW),
    getMind(),
    listPortrait(),
    getMeta(),
  ]);

  const liveMind = mind.turn_seq ? mind : EMPTY_MIND;
  const jumped = topicJump(input.text, liveMind);
  const picked = await pickHotNotes(mind.memory_ids ?? [], input.text, { jump: jumped.jump });
  const notes = picked.notes;
  const pickedIds = picked.mindIds;
  const fallbackIds = picked.queryIds;
  let careHint = false;
  if (process.env.QR_CARE_CHECKIN === "true") {
    const day = localDay(input.nowMs, input.timeZone);
    const log = await getDay(day);
    const asked = history.some(
      (m) => m.role === "assistant" && /今天过得|睡得如何|睡得好/.test(m.text),
    );
    careHint = Boolean(log && log.coverage !== "ok" && !asked);
  }

  const mindAgeMs = liveMind.updated_at ? input.nowMs - liveMind.updated_at : 0;
  const mindStale = Boolean(liveMind.updated_at) && mindAgeMs > SESSION_GAP_MS;
  const clockText = formatClock(input.nowMs, input.timeZone);
  const tail = buildTail({
    clock: clockText,
    mind: liveMind,
    notes,
    timeZone: input.timeZone,
    careHint,
    nowMs: input.nowMs,
    stale: mindStale && Boolean(liveMind.updated_at) && liveMind.turn_seq > 0,
    jump: jumped.jump,
  });

  const longterm = renderVoiceLongterm(meta.selfSummary, meta.bondSummary, portrait);
  const charter = input.profile.systemPrompt;
  const parts: VoicePackParts = {
    charter,
    longterm,
    history,
    userText: input.text,
    mind: liveMind,
    notes,
    clockText,
    timeZone: input.timeZone,
    careHint,
    nowMs: input.nowMs,
    mindStale,
    jump: jumped.jump,
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
    jump: jumped.jump,
    jumpScore: jumped.score,
    careHint,
    clockText,
    userMsgId: input.userMsgId,
    timeZone: input.timeZone,
    mindAgeMs,
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
    jump: jumped.jump,
    jumpScore: jumped.score,
    careHint,
    charterHash,
    longtermHash,
    historyIds,
    clockText,
    timeZone: input.timeZone,
    refs,
    parts,
    inputChars,
  };
}

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
import { buildTail, buildVoiceMessages, renderVoiceLongterm } from "./pack-build.ts";

export { buildTail, buildVoiceMessages, renderVoiceLongterm } from "./pack-build.ts";

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
  careHint: boolean;
  charterHash: string;
  longtermHash: string;
  historyIds: string[];
  clockText: string;
  timeZone: string;
  refs: VoiceRefs;
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
  const user =
    userExisting ??
    (await upsertMessage({
      id: input.userMsgId,
      role: "user",
      text: input.text,
      createdAt: input.userCreatedAt || input.nowMs,
      timeZone: input.timeZone,
    }));

  const [history, mind, portrait, meta] = await Promise.all([
    listHistoryWindow(input.userMsgId, HISTORY_WINDOW),
    getMind(),
    listPortrait(),
    getMeta(),
  ]);

  const notes = await pickHotNotes(mind.memory_ids ?? [], input.text);
  const pickedIds = notes.filter((n) => (mind.memory_ids ?? []).includes(n.id)).map((n) => n.id);
  const fallbackIds = notes.filter((n) => !(mind.memory_ids ?? []).includes(n.id)).map((n) => n.id);
  let careHint = false;
  if (process.env.QR_CARE_CHECKIN === "true") {
    const day = localDay(input.nowMs, input.timeZone);
    const log = await getDay(day);
    const asked = history.some(
      (m) => m.role === "assistant" && /今天过得|睡得如何|睡得好/.test(m.text),
    );
    careHint = Boolean(log && log.coverage !== "ok" && !asked);
  }

  const liveMind = mind.turn_seq ? mind : EMPTY_MIND;
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
  });

  const longterm = renderVoiceLongterm(meta.selfSummary, meta.bondSummary, portrait);
  const charter = input.profile.systemPrompt;
  const [charterHash, longtermHash] = await Promise.all([
    rememberCharter(charter.trim() || "你就是清然。正在和 Rosie 语音通话。"),
    rememberBlock("voice_longterm", longterm),
  ]);

  const messages = buildVoiceMessages({
    charter,
    longterm,
    history,
    tail,
    userText: input.text,
  });

  const historyIds = history.map((m) => m.id);
  const refs: VoiceRefs = {
    charterHash,
    longtermHash,
    historyIds,
    mindTurnSeq: liveMind.turn_seq,
    mindStale,
    pickedIds,
    fallbackIds,
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
    careHint,
    charterHash,
    longtermHash,
    historyIds,
    clockText,
    timeZone: input.timeZone,
    refs,
  };
}

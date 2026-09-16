import type { Profile } from "../../types.ts";
import { HISTORY_WINDOW, QR_CARE_CHECKIN } from "../config.ts";
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
import { buildTail, buildVoiceMessages } from "./pack-build.ts";

export { buildTail, buildVoiceMessages } from "./pack-build.ts";

export type HotContext = {
  messages: VoiceChatMessage[];
  packMs: number;
  sessionId: string | null;
  user: StoredMessage;
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
  const userExisting = await getMessage(input.userMsgId);
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
  let careHint = false;
  if (QR_CARE_CHECKIN) {
    const day = localDay(input.nowMs, input.timeZone);
    const log = await getDay(day);
    const asked = history.some(
      (m) => m.role === "assistant" && /今天过得|睡得如何|睡得好/.test(m.text),
    );
    careHint = Boolean(log && log.coverage !== "ok" && !asked);
  }

  const tail = buildTail({
    clock: formatClock(input.nowMs, input.timeZone),
    mind: mind.turn_seq ? mind : EMPTY_MIND,
    notes,
    timeZone: input.timeZone,
    careHint,
  });

  const messages = buildVoiceMessages({
    charter: input.profile.systemPrompt,
    selfSummary: meta.selfSummary,
    bondSummary: meta.bondSummary,
    portrait,
    history,
    tail,
    userText: input.text,
  });

  return {
    messages,
    packMs: Date.now() - t0,
    sessionId: user.sessionId,
    user,
  };
}

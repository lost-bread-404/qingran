import { getHeart, mindForReply, timeFacts, todayText } from "../heart.ts";
import { mergeEditedUserBody } from "../../message-markup.ts";
import { NEUTRAL_PERSONA, voiceInjectFromProfile, type Profile, type VoiceInjectFlags } from "../../types.ts";
import { rememberBlock, rememberCharter, type VoiceRefs } from "../log-refs.ts";
import { getMessage, listHistoryWindow, upsertMessage } from "../store.ts";
import type { StoredMessage, VoiceChatMessage } from "../types.ts";
import { loadPrompt } from "../prompts/store.ts";
import { dossierTextForModel } from "../dossier.ts";
import { identityBlock } from "../life.ts";
import { buildVoiceMessages, voiceInputChars, type VoiceInputChars, type VoicePackParts } from "./pack-build.ts";

export type HotContext = {
  messages: VoiceChatMessage[];
  packMs: number;
  dbFirstMs: number;
  sessionId: string | null;
  user: StoredMessage;
  mindTurnSeq: number;
  mindAgeMs: number;
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
  /** What only he knows, as given to this reply. */
  injected: { now: string; today: string };
  intimateInjected: boolean;
  personaPlacement: "system" | "first_user";
};

/** Everything the reply needs, read before the model is called (no model call here). */
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
  const dbFirstMs = Date.now() - t0;
  const user = await upsertMessage({
    id: input.userMsgId,
    role: "user",
    text: mergeEditedUserBody(userExisting?.text, input.text),
    createdAt: userExisting?.createdAt || input.userCreatedAt || input.nowMs,
    kind: userExisting?.kind,
    timeZone: input.timeZone,
  });

  // Brain off → persona + mode + context only.
  const brainOn = input.profile.brainOn;
  const inject = voiceInjectFromProfile(input.profile);
  inject.moment = inject.moment && brainOn;
  inject.dossier = inject.dossier && brainOn;
  const [history, heart, dossier, mind, today, clockText, voicePrompt] = await Promise.all([
    listHistoryWindow(input.userMsgId, inject.history),
    getHeart(),
    inject.dossier ? dossierTextForModel() : Promise.resolve(""),
    inject.moment ? mindForReply(input.nowMs, input.timeZone) : Promise.resolve(""),
    inject.moment ? todayText(input.nowMs, input.timeZone) : Promise.resolve(""),
    timeFacts(input.nowMs, input.timeZone, input.userCreatedAt),
    loadPrompt("voice"),
  ]);
  const charter = input.profile.systemPrompt;
  // Intimate notes follow the mode: shown while the current mode is marked intimate.
  const modeDef = input.profile.modes.find((m) => m.id === input.profile.mode);
  const intimate = modeDef?.intimate ? input.profile.intimateNotes.trim() : "";
  const parts: VoicePackParts = {
    charter,
    identity: identityBlock(input.profile.identity),
    dossier,
    mind,
    today,
    intimate,
    clock: clockText,
    history,
    historyWindow: inject.history,
    userText: input.text,
    voiceTemplate: voicePrompt.body,
    personaPlacement: input.profile.personaPlacement,
    personaAck: input.profile.personaAck,
  };
  const [charterHash, longtermHash] = await Promise.all([
    rememberCharter(charter.trim() || NEUTRAL_PERSONA),
    rememberBlock("voice_longterm", dossier),
  ]);
  const historyIds = history.map((m) => m.id);
  const mindAgeMs = heart.updatedAt ? input.nowMs - heart.updatedAt : 0;
  const refs: VoiceRefs = {
    charterHash,
    longtermHash,
    historyIds,
    mindTurnSeq: heart.turnSeq,
    mindStale: false,
    pickedIds: [],
    fallbackIds: [],
    queryIds: [],
    queryScores: [],
    jump: false,
    jumpScore: 0,
    careHint: false,
    clockText,
    userMsgId: input.userMsgId,
    timeZone: input.timeZone,
    mindAgeMs,
    injectLongterm: inject.dossier,
    injectMoment: inject.moment,
    momentNow: mind,
    historyWindow: inject.history,
  };

  return {
    messages: buildVoiceMessages(parts, "none"),
    packMs: Date.now() - t0,
    dbFirstMs,
    sessionId: user.sessionId,
    user,
    mindTurnSeq: heart.turnSeq,
    mindAgeMs,
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
    injected: { now: mind, today },
    intimateInjected: Boolean(intimate),
    personaPlacement: input.profile.personaPlacement,
  };
}

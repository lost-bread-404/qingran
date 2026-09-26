import { mindForReply, timeFacts } from "../heart.ts";
import { mergeEditedUserBody } from "../../message-markup.ts";
import { NEUTRAL_PERSONA, voiceInjectFromProfile, type Profile, type VoiceInjectFlags } from "../../types.ts";
import { rememberBlock, rememberCharter, type VoiceRefs } from "../log-refs.ts";
import { getInner, getMessage, getMeta, listHistoryWindow, listPortrait, upsertMessage } from "../store.ts";
import type { StoredMessage, VoiceChatMessage } from "../types.ts";
import { loadPrompt } from "../prompts/store.ts";
import { personaAckText } from "../prompts/doc.ts";
import { ensureMemoryHygiene } from "../memory-hygiene.ts";
import { getDossier } from "../dossier.ts";
import { identityBlock } from "../life.ts";
import {
  buildTail,
  renderDossierBlock,
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

export type InjectedInner = {
  feel: string;
  desire: string;
  now: string;
  longing: string;
  glow: string;
  stale: { moment: boolean; longing: boolean };
};

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
  injected: InjectedInner;
  intimateInjected: boolean;
  personaPlacement: "system" | "first_user";
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

  // Brain off → persona + context only. Brain on → full memory and his private mind.
  const brainOn = input.profile.brainOn;
  const inject = voiceInjectFromProfile(input.profile);
  inject.moment = inject.moment && brainOn;
  inject.dossier = inject.dossier && brainOn;
  const [history, inner, dossierRow, mindText, clockText] = await Promise.all([
    listHistoryWindow(input.userMsgId, inject.history),
    getInner(),
    getDossier(),
    inject.moment ? mindForReply(input.nowMs, input.timeZone) : Promise.resolve(""),
    timeFacts(input.nowMs, input.timeZone, input.userCreatedAt),
  ]);
  const legacy = dossierRow.active
    ? null
    : await Promise.all([getMeta(), listPortrait()]).then(([meta, portrait]) => ({ meta, portrait }));

  const injected: InjectedInner = {
    feel: "",
    desire: "",
    now: mindText,
    longing: "",
    glow: "",
    stale: { moment: false, longing: false },
  };
  const mindAgeMs = inner.updated_at ? input.nowMs - inner.updated_at : 0;
  const mindStale = false;
  const careHint = false;
  const moment = { feel: "", desire: "", now: mindText, longing: "", glow: "" };
  const tail = buildTail({ clock: clockText, moment, inject });
  const longterm = !inject.dossier
    ? ""
    : dossierRow.active
      ? dossierRow.body.trim()
        ? renderDossierBlock(dossierRow.body)
        : ""
      : renderVoiceLongterm(legacy!.meta.selfSummary, legacy!.meta.bondSummary, legacy!.portrait);
  const charter = input.profile.systemPrompt;
  const [loaded, ackPrompt] = await Promise.all([loadPrompt("voice"), loadPrompt("persona_ack")]);
  // Intimate notes follow the mode: shown while the current mode is marked intimate.
  const modeDef = input.profile.modes.find((m) => m.id === input.profile.mode);
  const intimate = modeDef?.intimate ? input.profile.intimateNotes.trim() : "";
  const parts: VoicePackParts = {
    charter,
    longterm,
    history,
    userText: input.text,
    moment,
    clockText,
    timeZone: input.timeZone,
    nowMs: input.nowMs,
    voiceTemplate: loaded.body,
    selfSummary: dossierRow.active ? undefined : legacy!.meta.selfSummary,
    bondSummary: dossierRow.active ? undefined : legacy!.meta.bondSummary,
    portrait: dossierRow.active ? undefined : legacy!.portrait,
    injectMoment: inject.moment,
    injectDossier: inject.dossier && Boolean(longterm),
    historyWindow: inject.history,
    identity: identityBlock(input.profile.identity),
    personaPlacement: input.profile.personaPlacement,
    personaAck: personaAckText(ackPrompt.body),
    intimateNotes: intimate,
  };
  const [charterHash, longtermHash] = await Promise.all([
    rememberCharter(charter.trim() || NEUTRAL_PERSONA),
    rememberBlock("voice_longterm", longterm),
  ]);

  const messages = voiceMessagesForStrip(parts, "none");
  const inputChars = voiceInputChars(parts);
  const historyIds = history.map((m) => m.id);
  const refs: VoiceRefs = {
    charterHash,
    longtermHash,
    historyIds,
    mindTurnSeq: inner.turn_seq,
    mindStale,
    pickedIds: [],
    fallbackIds: [],
    queryIds: [],
    queryScores: [],
    jump: false,
    jumpScore: 0,
    careHint,
    clockText,
    userMsgId: input.userMsgId,
    timeZone: input.timeZone,
    mindAgeMs,
    injectLongterm: inject.dossier,
    injectMoment: inject.moment,
    momentFeel: moment.feel,
    momentWant: moment.desire,
    momentNow: moment.now,
    momentLonging: moment.longing,
    historyWindow: inject.history,
  };

  return {
    messages,
    packMs: Date.now() - t0,
    dbFirstMs,
    sessionId: user.sessionId,
    user,
    tail,
    mindTurnSeq: inner.turn_seq,
    mindAgeMs,
    mindStale,
    pickedIds: [],
    fallbackIds: [],
    queryIds: [],
    queryScores: [],
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
    injected,
    intimateInjected: Boolean(intimate),
    personaPlacement: input.profile.personaPlacement,
  };
}

/** What the reply would be given for the dossier and the public inner fields. */
export async function loadVoicePerspective(): Promise<{
  dossier: string;
  feel: string;
  desire: string;
  now: string;
  longing: string;
}> {
  const { dossierTextForModel } = await import("../dossier.ts");
  const inner = await getInner();
  return {
    dossier: await dossierTextForModel(),
    feel: inner.feel,
    desire: inner.desire,
    now: inner.now,
    longing: inner.longing,
  };
}

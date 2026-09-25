import { mergeEditedUserBody } from "../../message-markup.ts";
import { voiceInjectFromProfile, type Profile, type VoiceInjectFlags } from "../../types.ts";
import { rememberBlock, rememberCharter, type VoiceRefs } from "../log-refs.ts";
import { getInner, getMessage, getMeta, listHistoryWindow, listPortrait, upsertMessage } from "../store.ts";
import { formatPlansForPrompt, momentForVoice } from "../mind-parse.ts";
import { formatClock } from "../time.ts";
import type { StoredMessage, VoiceChatMessage } from "../types.ts";
import { loadPrompt } from "../prompts/store.ts";
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
  const [history, inner, dossierRow] = await Promise.all([
    listHistoryWindow(input.userMsgId, inject.history),
    getInner(),
    getDossier(),
  ]);
  const legacy = dossierRow.active
    ? null
    : await Promise.all([getMeta(), listPortrait()]).then(([meta, portrait]) => ({ meta, portrait }));

  const injected = momentForVoice(
    inner,
    input.nowMs,
    inject.moment,
    Math.round(input.profile.glowHalfLifeDays * 24 * 60 * 60 * 1000),
  );
  const mindAgeMs = inner.updated_at ? input.nowMs - inner.updated_at : 0;
  const mindStale = injected.stale.moment;
  const careHint = false;
  const clockText = formatClock(input.nowMs, input.timeZone);
  const moment = {
    feel: injected.feel,
    desire: injected.desire,
    now: injected.now,
    longing: injected.longing,
    glow: injected.glow,
  };
  const tail = buildTail({ clock: clockText, moment, inject });
  const longterm = dossierRow.active
    ? renderDossierBlock(dossierRow.body)
    : renderVoiceLongterm(legacy!.meta.selfSummary, legacy!.meta.bondSummary, legacy!.portrait);
  const charter = input.profile.systemPrompt;
  const loaded = await loadPrompt("voice");
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
    injectDossier: inject.dossier,
    historyWindow: inject.history,
    identity: identityBlock(input.profile.identity),
    plansText: formatPlansForPrompt(inner.plans),
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

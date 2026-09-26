import { resolveVoiceChat, voiceSafetyPick, type VoiceModelPick } from "../config.ts";
import { dossierTextForModel } from "../dossier.ts";
import { mindForReply, timeFacts, todayText } from "../heart.ts";
import { identityBlock } from "../life.ts";
import { callModel } from "../llm.ts";
import { effectiveMode } from "../mode.ts";
import { loadPrompt } from "../prompts/store.ts";
import { getProfileData, listHistoryWindow } from "../store.ts";
import { resolveTalkProfile } from "../../talk-profile.ts";
import { lockedProfile, voiceInjectFromProfile } from "../../types.ts";
import { InnerCutBuffer } from "./inner-cut.ts";
import { buildVoiceMessages, type VoicePackParts } from "./pack-build.ts";

function quietText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`;
}

/**
 * A message he starts himself (a plan came due while she was away).
 * The mind only decided to reach her and what for; the words come from the same voice that answers her:
 * same persona, current mode, memory, heart and recent talk, told that nothing new came from her.
 */
export async function speakFirst(input: {
  intent: string;
  nowMs: number;
  timeZone: string;
  lastUserAt: number | null;
}): Promise<{ text: string; model: string; ms: number; reason: string | null }> {
  const saved = await getProfileData();
  const ids = lockedProfile(saved).modes.map((m) => m.id);
  const mode = await effectiveMode(input.nowMs, input.timeZone, ids);
  const { profile } = resolveTalkProfile(undefined, saved, mode);
  const inject = voiceInjectFromProfile(profile);
  const [history, dossier, mind, today, clock, voicePrompt] = await Promise.all([
    listHistoryWindow(null, inject.history),
    inject.dossier ? dossierTextForModel() : Promise.resolve(""),
    inject.moment ? mindForReply(input.nowMs, input.timeZone) : Promise.resolve(""),
    inject.moment ? todayText(input.nowMs, input.timeZone) : Promise.resolve(""),
    timeFacts(input.nowMs, input.timeZone, input.nowMs),
    loadPrompt("voice"),
  ]);
  const modeDef = profile.modes.find((m) => m.id === profile.mode);
  const parts: VoicePackParts = {
    charter: profile.systemPrompt,
    identity: identityBlock(profile.identity),
    dossier,
    mind,
    today,
    intimate: modeDef?.intimate ? profile.intimateNotes.trim() : "",
    clock,
    history,
    historyWindow: inject.history,
    userText: "",
    first: {
      quiet: input.lastUserAt ? quietText(input.nowMs - input.lastUserAt) : "很久",
      intent: input.intent.trim(),
    },
    voiceTemplate: voicePrompt.body,
    personaPlacement: profile.personaPlacement,
    personaAck: profile.personaAck,
  };
  const messages = buildVoiceMessages(parts, "none");
  const primary = resolveVoiceChat(profile.voiceModel, profile.voiceEffort);
  const picks: VoiceModelPick[] = [primary];
  const safety = voiceSafetyPick();
  if (safety.model !== primary.model || safety.effort !== primary.effort) picks.push(safety);

  let last = { model: primary.model, ms: 0 };
  for (const pick of picks) {
    const result = await callModel("voice", {
      system: "",
      input: "",
      messages,
      model: pick.model,
      effort: pick.effort,
      temperature: modeDef?.temperature ?? undefined,
      promptKey: voicePrompt.key,
      promptHash: voicePrompt.hash,
      outputRef: `first:${input.nowMs}`,
    });
    last = { model: result.model, ms: result.ms };
    if (!result.ok) continue;
    const cut = new InnerCutBuffer();
    cut.push(result.text);
    cut.finish();
    const text = cut.speech.trim();
    if (text) return { text: text.slice(0, 2000), model: result.model, ms: result.ms, reason: null };
  }
  return { text: "", model: last.model, ms: last.ms, reason: "模型没有回话" };
}

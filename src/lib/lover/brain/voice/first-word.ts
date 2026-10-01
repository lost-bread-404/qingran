import { resolveVoiceChat, voiceSafetyPick, type VoiceModelPick } from "../config.ts";
import { timeFacts } from "../heart.ts";
import { identityBlock } from "../life.ts";
import { callModel } from "../llm.ts";
import { loadPrompt } from "../prompts/store.ts";
import { getProfileData } from "../store.ts";
import { dossierTextForModel } from "../dossier.ts";
import { recall, recallText } from "../memory.ts";
import { resolveTalkProfile } from "../../talk-profile.ts";
import { voiceInjectFromProfile } from "../../types.ts";
import { InnerCutBuffer } from "./inner-cut.ts";
import { BraceCut } from "./brace-cut.ts";
import { buildVoiceMessages, type VoicePackParts } from "./pack-build.ts";
import { recallQuery, replyHistory } from "./pack.ts";

function quietText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`;
}

/** His answer when he does not want to write to her now. */
const PASS = /^[（(]?\s*不找\s*[。.]?\s*[）)]?$/;

/**
 * A message he may start himself, when she has been quiet a while (requirements 第 5 节).
 * The same voice that answers her decides whether to write and what: same persona, memory and today's talk,
 * told how long she has been quiet. 「不找」 = he lets it be.
 */
export async function speakFirst(input: {
  nowMs: number;
  timeZone: string;
  lastUserAt: number | null;
}): Promise<{ text: string; passed: boolean; model: string; ms: number; reason: string | null }> {
  const { profile } = resolveTalkProfile(undefined, await getProfileData());
  const inject = voiceInjectFromProfile(profile);
  const [history, us, clock, voicePrompt] = await Promise.all([
    replyHistory(null, inject.history, input.nowMs, input.timeZone),
    inject.memory ? dossierTextForModel() : Promise.resolve(""),
    timeFacts(input.nowMs, input.timeZone, input.nowMs),
    loadPrompt("voice"),
  ]);
  const recalled = inject.memory ? await recall(recallQuery("", history), input.nowMs) : { memories: [] };
  const parts: VoicePackParts = {
    charter: profile.systemPrompt,
    identity: identityBlock(profile.identity),
    us,
    recall: recallText(recalled.memories),
    intimate: "",
    clock,
    history,
    historyWindow: history.length,
    userText: "",
    first: { quiet: input.lastUserAt ? quietText(input.nowMs - input.lastUserAt) : "很久" },
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
      promptKey: voicePrompt.key,
      promptHash: voicePrompt.hash,
      outputRef: `first:${input.nowMs}`,
    });
    last = { model: result.model, ms: result.ms };
    if (!result.ok) continue;
    const cut = new InnerCutBuffer();
    cut.push(new BraceCut().push(result.text));
    cut.finish();
    const text = cut.speech.trim();
    if (PASS.test(text)) return { text: "", passed: true, model: result.model, ms: result.ms, reason: null };
    if (text) return { text: text.slice(0, 2000), passed: false, model: result.model, ms: result.ms, reason: null };
  }
  return { text: "", passed: false, model: last.model, ms: last.ms, reason: "模型没有回话" };
}

import { resolveVoiceChat, voiceSafetyPick, type VoiceModelPick } from "../config.ts";
import { timeFacts } from "../heart.ts";
import { identityBlock } from "../life.ts";
import { callModel } from "../llm.ts";
import { loadPrompt } from "../prompts/store.ts";
import { getProfileData } from "../store.ts";
import { dossierTextForModel } from "../dossier.ts";
import { keepInner, recall, recallText, recentInner } from "../memory.ts";
import { resolveTalkProfile } from "../../talk-profile.ts";
import { personaText, voiceInjectFromProfile } from "../../types.ts";
import { InnerCutBuffer } from "./inner-cut.ts";
import { BraceCut } from "./brace-cut.ts";
import { buildVoiceMessages, type VoicePackParts } from "./pack-build.ts";
import { recallQuery, replyHistory, withInner } from "./pack.ts";

const CN = ["零", "一", "两", "三", "四", "五", "六", "七", "八", "九", "十"];
function cn(n: number): string {
  if (n <= 10) return CN[n]!;
  const ones = (k: number) => (k === 2 ? "二" : CN[k]!);
  if (n < 20) return `十${ones(n - 10)}`;
  if (n < 30) return `二十${n === 20 ? "" : ones(n - 20)}`;
  return `${n}`;
}

/** Roughly how long she has been away (an exact count of minutes ends up said out loud). */
export function quietText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 40) return "一会儿";
  if (m < 60) return "快一个小时";
  const h = Math.floor(m / 60);
  if (h < 24) return `${h === 1 ? "一" : cn(h)}个${m % 60 >= 10 ? "多" : ""}小时`;
  const d = Math.floor(h / 24);
  return `${d === 1 ? "一" : cn(d)}天${h % 24 >= 3 ? "多" : ""}`;
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
  const [history, us, clockText, inner, voicePrompt] = await Promise.all([
    replyHistory(null, inject.history, input.nowMs, input.timeZone),
    inject.memory ? dossierTextForModel() : Promise.resolve(""),
    // Only the time of day: how long she has been away is said roughly in the note below.
    timeFacts(input.nowMs, input.timeZone, input.nowMs, { sinceLast: false }),
    recentInner(input.nowMs),
    loadPrompt("voice"),
  ]);
  const clock = withInner(clockText, inner);
  const recalled = inject.memory ? await recall(recallQuery("", history), input.nowMs) : { memories: [] };
  const parts: VoicePackParts = {
    charter: personaText(profile),
    identity: identityBlock(profile.identity),
    us,
    recall: recallText(recalled.memories),
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
    const braces = new BraceCut();
    const cut = new InnerCutBuffer();
    cut.push(braces.push(result.text));
    braces.finish();
    cut.finish();
    const text = cut.speech.trim();
    if (PASS.test(text)) return { text: "", passed: true, model: result.model, ms: result.ms, reason: null };
    if (text) await keepInner(braces.text(), input.nowMs, input.timeZone);
    if (text) return { text: text.slice(0, 2000), passed: false, model: result.model, ms: result.ms, reason: null };
  }
  return { text: "", passed: false, model: last.model, ms: last.ms, reason: "模型没有回话" };
}

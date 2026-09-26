import { lockedProfile, voiceInjectFromProfile } from "../../types.ts";
import { now } from "../clock.ts";
import { getMeta, getProfileData, getProfilePrompt, listHistoryWindow } from "../store.ts";
import { localDay } from "../time.ts";
import { resolveTz } from "../tz.ts";
import { isPromptKey, promptSpec, type PromptKey } from "./catalog.ts";
import { parsePromptBody, personaAckText, renderVariant, type RenderedMessage } from "./doc.ts";
import { loadPrompt } from "./store.ts";
import { buildVoiceMessages, voiceHistoryMessages } from "../voice/pack-build.ts";
import { gatherReflectParts, modesText, reflectVars } from "../voice/reflector.ts";
import { getHeart, listPlans, mindForReply, plansText, timeFacts, todayText } from "../heart.ts";
import { dossierTextForModel } from "../dossier.ts";
import { identityBlock } from "../life.ts";

export type PromptPreview = {
  variantId: string;
  slots: Record<string, string>;
  messages: Array<{ role: string; content: string }>;
  note: string;
};

/** What the reply would be given right now, with 「在吗」 standing in for her line. */
async function voicePreview(body: string | undefined): Promise<Omit<PromptPreview, "variantId">> {
  const at = now();
  const [meta, charter, profileData, ackPrompt] = await Promise.all([getMeta(), getProfilePrompt(), getProfileData(), loadPrompt("persona_ack")]);
  const profile = lockedProfile(profileData);
  const tz = resolveTz(meta.timeZone);
  const inject = voiceInjectFromProfile(profile);
  const brainOn = profile.brainOn;
  const [history, dossier, mind, today, clock] = await Promise.all([
    listHistoryWindow(null, inject.history),
    inject.dossier && brainOn ? dossierTextForModel() : Promise.resolve(""),
    inject.moment && brainOn ? mindForReply(at, tz) : Promise.resolve(""),
    inject.moment && brainOn ? todayText(at, tz) : Promise.resolve(""),
    timeFacts(at, tz, at),
  ]);
  const messages = buildVoiceMessages({
    charter,
    identity: identityBlock(profile.identity),
    dossier,
    mind,
    today,
    intimate: "",
    clock,
    history,
    historyWindow: inject.history,
    userText: "在吗",
    voiceTemplate: body,
    personaPlacement: profile.personaPlacement,
    personaAck: personaAckText(ackPrompt.body),
  });
  const historyText =
    voiceHistoryMessages(history, inject.history)
      .map((message) => `${message.role}：${message.content}`)
      .join("\n") || "（没有对话）";
  return {
    slots: { dossier, now: mind, today, system_prompt: charter, clock, user_text: "在吗", history_messages: historyText },
    messages,
    note: "没有正在说的这一句，用「在吗」占位。人设这里不带当前模式的 prompt，亲密设定也不放。",
  };
}

async function editorSlots(): Promise<Record<string, string>> {
  const tz = resolveTz((await getMeta()).timeZone);
  const at = now();
  const [dossier, charter, heart, plans, today, profileData] = await Promise.all([
    dossierTextForModel(),
    getProfilePrompt(),
    getHeart(),
    listPlans(),
    todayText(at, tz),
    getProfileData(),
  ]);
  const profile = lockedProfile(profileData);
  return {
    system_prompt: charter,
    identity_block: identityBlock(profile.identity) ? `${identityBlock(profile.identity)}\n` : "",
    story: profile.storyline || "（没有）",
    dossier: dossier || "（还没有）",
    heart: heart.text || "（空）",
    plans: plansText(plans, at, tz) || "（没有）",
    today: today || "（没有）",
    day: localDay(at, tz),
    modes: modesText(profile.modes, "") || "（没有）",
    conversation: "（要等这次整理才有：这一天没被清空的对话）",
    max_chars: String(profile.dossierMaxChars),
  };
}

async function slotsFor(key: PromptKey): Promise<{ slots: Record<string, string>; note: string }> {
  if (key === "reflect") {
    return { slots: reflectVars((await gatherReflectParts(now(), { kind: "turn" })).parts), note: "这是她刚说完话时，这一刻心思会读到的材料。" };
  }
  if (key === "editor") {
    return { slots: await editorSlots(), note: "整理时会带上这一天没被清空的对话。这里先给出记得的、心里、打算和今天。" };
  }
  if (key === "report") {
    return {
      slots: { summaries: "（预览）生成时这里是这个月每天的时间线和对话摘要。", chunk: "（预览）一段按天切开的对话。" },
      note: "月报读每天的时间线和对话原文。对话太长时先走分段摘要。",
    };
  }
  return { slots: {}, note: "" };
}

function render(key: PromptKey, variantId: string, body: string | undefined, slots: Record<string, string>): RenderedMessage[] {
  const spec = promptSpec(key);
  const id = spec.variants.some((variant) => variant.id === variantId) ? variantId : spec.variants[0]?.id ?? "main";
  return renderVariant(parsePromptBody(key, body), id, slots);
}

export async function previewPrompt(input: { key: string; variantId?: string; body?: string }): Promise<PromptPreview> {
  if (!isPromptKey(input.key)) throw new Error("unknown-prompt");
  const key = input.key;
  const spec = promptSpec(key);
  const variantId = spec.variants.some((variant) => variant.id === input.variantId) ? input.variantId! : spec.variants[0]?.id ?? "main";
  if (key === "voice") return { variantId, ...(await voicePreview(input.body)) };
  const loaded = await slotsFor(key);
  return { variantId, slots: loaded.slots, messages: render(key, variantId, input.body, loaded.slots), note: loaded.note };
}

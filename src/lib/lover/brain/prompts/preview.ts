import { lockedProfile, personaText, voiceInjectFromProfile } from "../../types.ts";
import { now } from "../clock.ts";
import { getMeta, getProfileData, getProfilePrompt } from "../store.ts";
import { localDay } from "../time.ts";
import { resolveTz } from "../tz.ts";
import { isPromptKey, promptSpec, type PromptKey } from "./catalog.ts";
import { parsePromptBody, renderVariant, type RenderedMessage } from "./doc.ts";
import { buildVoiceMessages, voiceHistoryMessages } from "../voice/pack-build.ts";
import { recallQuery, replyHistory } from "../voice/pack.ts";
import { timeFacts } from "../heart.ts";
import { dossierTextForModel } from "../dossier.ts";
import { listMemories, memoriesWithIds, recall, recallText } from "../memory.ts";
import { identityBlock } from "../life.ts";
import { resolveTalkProfile } from "../../talk-profile.ts";

export type PromptPreview = {
  variantId: string;
  slots: Record<string, string>;
  messages: Array<{ role: string; content: string }>;
  note: string;
};

/** What the reply would be given right now, with 「在吗」 standing in for her line. */
async function voicePreview(body: string | undefined, variantId: string): Promise<Omit<PromptPreview, "variantId">> {
  const first = variantId === "first" ? { quiet: "45 分钟" } : undefined;
  const userText = first ? "" : "在吗";
  const at = now();
  const [meta, profileData] = await Promise.all([getMeta(), getProfileData()]);
  const tz = resolveTz(meta.timeZone);
  const profile = resolveTalkProfile(undefined, profileData).profile;
  const charter = personaText(profile);
  const inject = voiceInjectFromProfile(profile);
  const [history, us, clock] = await Promise.all([
    replyHistory(null, inject.history, at, tz),
    inject.memory ? dossierTextForModel() : Promise.resolve(""),
    timeFacts(at, tz, at),
  ]);
  const recalled = inject.memory ? await recall(recallQuery(userText, history), at) : { memories: [] };
  const recallBlock = recallText(recalled.memories);
  const messages = buildVoiceMessages({
    charter,
    identity: identityBlock(profile.identity),
    us,
    recall: recallBlock,
    clock,
    history,
    historyWindow: history.length,
    userText,
    first,
    voiceTemplate: body,
    personaPlacement: profile.personaPlacement,
    personaAck: profile.personaAck,
  });
  const historyText =
    voiceHistoryMessages(history, history.length)
      .map((message) => `${message.role}：${message.content}`)
      .join("\n") || "（没有对话）";
  return {
    slots: {
      us,
      recall: recallBlock,
      system_prompt: charter,
      clock,
      user_text: userText,
      quiet: first?.quiet ?? "",
      history_messages: historyText,
    },
    messages,
    note: first ? "主动找她：多久没说话用占位。" : "没有正在说的这一句，用「在吗」占位；想起来的事按最近几句找。",
  };
}

async function editorSlots(): Promise<Record<string, string>> {
  const tz = resolveTz((await getMeta()).timeZone);
  const at = now();
  const [us, charter, profileData, memories] = await Promise.all([dossierTextForModel(), getProfilePrompt(), getProfileData(), listMemories()]);
  const profile = lockedProfile(profileData);
  return {
    system_prompt: charter,
    identity_block: identityBlock(profile.identity) ? `${identityBlock(profile.identity)}\n` : "",
    us: us || "（还没有）",
    memories: memoriesWithIds(memories.filter((m) => m.source === "night" || m.source === "rosie").slice(-200)) || "（没有）",
    day: localDay(at, tz),
    conversation: "（要等这次整理才有：这一天没被清空的对话）",
    max_chars: String(profile.dossierMaxChars),
  };
}

async function slotsFor(key: PromptKey): Promise<{ slots: Record<string, string>; note: string }> {
  if (key === "editor") {
    return { slots: await editorSlots(), note: "整理时带上这一天的对话，和以前所有的事、看懂的（同一件事接着聊就合并进去）。" };
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
  if (key === "voice") return { variantId, ...(await voicePreview(input.body, variantId)) };
  const loaded = await slotsFor(key);
  return { variantId, slots: loaded.slots, messages: render(key, variantId, input.body, loaded.slots), note: loaded.note };
}

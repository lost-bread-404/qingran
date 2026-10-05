import { lockedProfile, personaText } from "../../types.ts";
import { now } from "../clock.ts";
import { getMeta, getProfileData } from "../store.ts";
import { resolveTz } from "../tz.ts";
import { isPromptKey, promptSpec, type PromptKey } from "./catalog.ts";
import { parsePromptBody, renderVariant, type RenderedMessage } from "./doc.ts";
import { buildVoiceMessages, voiceHistoryMessages, voiceVars } from "../voice/pack-build.ts";
import { gatherVoiceParts, replyHistory } from "../voice/pack.ts";
import { dossierTextForModel } from "../dossier.ts";
import { resolveTalkProfile } from "../../talk-profile.ts";

export type PromptPreview = {
  variantId: string;
  slots: Record<string, string>;
  messages: Array<{ role: string; content: string }>;
  note: string;
};

/** What the reply would be given right now, with 「在吗」 standing in for her line. */
async function voicePreview(body: string | undefined, variantId: string): Promise<Omit<PromptPreview, "variantId">> {
  const first = variantId === "first" ? { quiet: "快一个小时" } : undefined;
  const userText = first ? "" : "在吗";
  const at = now();
  const [meta, profileData] = await Promise.all([getMeta(), getProfileData()]);
  const tz = resolveTz(meta.timeZone);
  const profile = resolveTalkProfile(undefined, profileData).profile;
  const { parts } = await gatherVoiceParts({
    profile,
    nowMs: at,
    timeZone: tz,
    history: replyHistory(null, at, tz),
    userText,
    first,
  });
  const withDraft = { ...parts, engine: "grok" as const, voiceTemplate: body ?? parts.voiceTemplate };
  const historyText =
    voiceHistoryMessages(parts.history, parts.history.length, parts.formats)
      .map((message) => `${message.role}：${message.content}`)
      .join("\n") || "（没有对话）";
  return {
    slots: { ...voiceVars(withDraft), history_messages: historyText },
    messages: buildVoiceMessages(withDraft),
    note: first ? "主动找她：多久没说话用占位。" : "没有正在说的这一句，用「在吗」占位。",
  };
}

async function editorSlots(): Promise<Record<string, string>> {
  const [us, profileData] = await Promise.all([dossierTextForModel(), getProfileData()]);
  const profile = lockedProfile(profileData);
  return {
    system_prompt: personaText(profile),
    identity: profile.identity.trim(),
    us: us.trim(),
    legacy: "",
    week: "（整理时才有：之前一周的对话，带时间）",
    today: "（整理时才有：这一天的对话，带时间）",
    inner: "",
    max_chars: String(profile.dossierMaxChars),
  };
}

async function slotsFor(key: PromptKey): Promise<{ slots: Record<string, string>; note: string }> {
  if (key === "editor") {
    return { slots: await editorSlots(), note: "整理时带上现在的 dossier、这一天和之前一周的对话（带时间）。用 Claude Opus 最高档。" };
  }
  if (key === "report") {
    return {
      slots: {
        timelines: "（预览）生成时这里是这个月每天的时间线。",
        summaries: "（预览）生成时这里是这个月的对话或摘要。",
        chunk: "（预览）一段按天切开的对话。",
      },
      note: "月报读每天的时间线和对话原文。对话太长时先走分段摘要。",
    };
  }
  return { slots: {}, note: "材料的写法不单独发给模型，其他几步用它写材料。" };
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

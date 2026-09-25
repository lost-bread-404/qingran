import { getSql } from "../../../db.ts";
import { voiceInjectFromProfile } from "../../types.ts";
import { now } from "../clock.ts";
import { HISTORY_WINDOW, REFLECT_WINDOW } from "../config.ts";
import { currentArchiveVars } from "../archivist.ts";
import { buildReportData } from "../diary/report.ts";
import {
  getMeta,
  getInner,
  getProfilePrompt,
  listDays,
  listFactors,
  listFindings,
  listHistoryWindow,
  listNotes,
  listPortrait,
  listThemes,
  messagesOnDay,
  openIntentions,
} from "../store.ts";
import { formatClock, localDay } from "../time.ts";
import { resolveTz } from "../tz.ts";
import { isPromptKey, promptSpec, type PromptKey } from "./catalog.ts";
import { parsePromptBody, renderVariant, type RenderedMessage } from "./doc.ts";
import { buildVoiceMessages, renderDossierBlock, voiceHistoryMessages } from "../voice/pack-build.ts";
import { formatReflectConversation, reflectVars } from "../voice/reflector.ts";
import { formatOldInner, momentForVoice } from "../mind-parse.ts";
import { dossierTextForModel, getDossier } from "../dossier.ts";

export type PromptPreview = {
  variantId: string;
  slots: Record<string, string>;
  messages: Array<{ role: string; content: string }>;
  note: string;
};

const NONE = "（没有）";
const LATER = "（要等这次调用才有。模板里的位置已经留好）";

function join(rows: string[], empty = NONE): string {
  const text = rows.filter((row) => row.trim()).join("\n");
  return text || empty;
}

async function profileData(): Promise<Record<string, unknown>> {
  try {
    const db = await getSql();
    const rows = await db.query<{ data: unknown }>("select data from qingran_profile where id = 1");
    const data = rows[0]?.data;
    if (typeof data === "string") return JSON.parse(data) as Record<string, unknown>;
    if (data && typeof data === "object") return data as Record<string, unknown>;
  } catch {
    /* preview still works with defaults */
  }
  return {};
}

async function voicePreview(body: string | undefined): Promise<Omit<PromptPreview, "variantId">> {
  const [meta, portrait, inner, charter, profile] = await Promise.all([
    getMeta(),
    listPortrait(),
    getInner(),
    getProfilePrompt(),
    profileData(),
  ]);
  const tz = resolveTz(meta.timeZone);
  const inject = voiceInjectFromProfile({
    injectMind: profile.injectMind !== false,
    injectLongterm: profile.injectLongterm !== false,
    historyWindow: typeof profile.historyWindow === "number" ? profile.historyWindow : HISTORY_WINDOW,
  });
  const history = await listHistoryWindow(null, inject.history);
  const clock = formatClock(now(), tz);
  const moment = momentForVoice(inner, now(), inject.moment);
  const dossierRow = await getDossier();
  const dossier = await dossierTextForModel();
  const historyText =
    voiceHistoryMessages(history, inject.history)
      .map((message) => `${message.role === "user" ? "user" : "assistant"}：${message.content}`)
      .join("\n") || "（没有对话）";
  const messages = buildVoiceMessages({
    charter,
    selfSummary: dossierRow.active ? undefined : meta.selfSummary,
    bondSummary: dossierRow.active ? undefined : meta.bondSummary,
    portrait: dossierRow.active ? undefined : portrait,
    longtermOverride: dossierRow.active ? renderDossierBlock(dossier) : null,
    history,
    userText: "在吗",
    moment,
    clock,
    timeZone: tz,
    voiceTemplate: body,
    inject,
  });
  return {
    slots: {
      dossier,
      desire: moment.desire,
      feel: moment.feel,
      longing: moment.longing,
      now: moment.now,
      system_prompt: charter,
      clock,
      user_text: "在吗",
      history_messages: historyText,
    },
    messages,
    note: "没有正在说的这一句，用户消息用「在吗」占位。档案和内心是发给回复模型前的文本，库里原文没改。",
  };
}

async function reflectSlots(): Promise<Record<string, string>> {
  const [history, charter, inner, dossier] = await Promise.all([
    listHistoryWindow(null, REFLECT_WINDOW),
    getProfilePrompt(),
    getInner(),
    dossierTextForModel(),
  ]);
  const meta = await getMeta();
  const tz = resolveTz(meta.timeZone);
  const at = now();
  return reflectVars({
    charter,
    dossier,
    clock: formatClock(at, tz),
    oldInner: formatOldInner(inner, at),
    conversation: formatReflectConversation(history, tz),
  });
}

async function editorSlots(): Promise<Record<string, string>> {
  const [dossier, inner, charter] = await Promise.all([dossierTextForModel(), getInner(), getProfilePrompt()]);
  return {
    system_prompt: charter,
    dossier: dossier || "（还没有）",
    longing: inner.longing.trim() || "（没有）",
    conversation: "（要等这次整理才有）",
    max_chars: "4000",
    story: "（要等这次生成才有）",
    legacy: "（要等这次生成才有）",
    notes: "（要等这次生成才有）",
  };
}

async function todayContext() {
  const meta = await getMeta();
  const tz = resolveTz(meta.timeZone);
  const day = localDay(now(), tz);
  const [messages, notes, intentions] = await Promise.all([
    messagesOnDay(day),
    listNotes({ fromDay: day, toDay: day, status: "active", limit: 80 }),
    openIntentions(),
  ]);
  return { meta, tz, day, messages, notes, intentions };
}

async function slotsFor(key: PromptKey, variantId: string): Promise<{ slots: Record<string, string>; note: string }> {
  if (key === "voice") {
    const preview = await voicePreview(undefined);
    return { slots: preview.slots, note: preview.note };
  }
  if (key === "reflect") return { slots: await reflectSlots(), note: "这是这一刻会写进内心的材料。" };
  if (key === "archive") return { slots: await currentArchiveVars(), note: "用当前滑出窗口的那一批。没有待归档时是空的。" };
  if (key === "editor") return { slots: await editorSlots(), note: "整理时会带上还没读过的对话。这里先给出文档和惦记。" };
  if (key === "dusk") {
    const { day, messages, notes, intentions } = await todayContext();
    const rosie = messages.filter((message) => message.role === "user").map((message) => message.text).join("\n").slice(0, 3000);
    const factors = await listFactors(true);
    const days = await listDays(day, day);
    const log = days[0];
    const base = {
      intentions: join(intentions.map((row) => `${row.id}|${row.status}|${row.tag ?? ""}|${row.text}`)),
      notes: variantId === "factors" ? join(notes.map((note) => note.text)) : join(notes.map((note) => `${note.id}|${note.text}`)),
      rosie_text: rosie || NONE,
      day,
      factors: join(factors.map((factor) => `${factor.id}|${factor.name}|${factor.definition}`)),
      day_log: log ? JSON.stringify(log) : NONE,
    };
    return { slots: base, note: "用今天。因子那一版在白天还没整理完时，day log 可能是空的。" };
  }
  if (key === "assign" || key === "synth" || key === "backfill") {
    const themes = await listThemes(false);
    const notes = await listNotes({ status: "active", limit: 20 });
    const factors = await listFactors(false);
    const findings = await listFindings();
    const meta = await getMeta();
    const tz = resolveTz(meta.timeZone);
    const day = localDay(now(), tz);
    const days = await listDays(day.slice(0, 8) + "01", day);
    return {
      slots: {
        themes: join(themes.slice(0, 20).map((theme) => `${theme.id}|${theme.name}|${theme.definition}`)),
        notes: join(notes.map((note) => `${note.id}|${note.localDay}|${note.text}`)).slice(0, 8000),
        name: LATER,
        definition: LATER,
        dates: day,
        day_logs: join(days.slice(-14).map((row) => `${row.day}|${row.summary}`)).slice(0, 6000),
        theme: themes[0] ? `${themes[0].name}：${themes[0].definition}` : NONE,
        weeks: LATER,
        factors: join(factors.slice(0, 20).map((factor) => `${factor.id}|${factor.name}|${factor.definition}`)),
        findings: join(findings.slice(0, 20).map((finding) => `${finding.kind}|${finding.antecedentId}->${finding.outcomeId}`)),
        factor_name: factors[0]?.name ?? LATER,
        factor_definition: factors[0]?.definition ?? LATER,
        days: join(days.slice(-14).map((row) => `${row.day}|${row.summary}|energy=${row.energy}|mood=${row.mood}`)),
      },
      note: "临时特征的名字、要标的周，要等那一次调用才有。其余用现在库里的主题、笔记和最近的天。",
    };
  }
  if (key === "ask") {
    const notes = await listNotes({ status: "active", fromRosie: true, limit: 20 });
    const meta = await getMeta();
    const tz = resolveTz(meta.timeZone);
    const day = localDay(now(), tz);
    const days = await listDays(day, day);
    return {
      slots: {
        question: "（你还没在日记里提问。预览用：这周状态怎么样）",
        notes: join(notes.map((note) => `${note.localDay} ${note.id} ${note.text}`)),
        day_logs: join(days.map((row) => `${row.day} ${row.energy ?? ""} ${row.mood ?? ""} ${row.summary}`)),
      },
      note: "提问那一条用了一句占位。笔记是按日记检索前的最近 20 条。",
    };
  }
  if (key === "report") {
    return {
      slots: { summaries: "（预览）生成时这里是这个月的对话摘要。", chunk: "（预览）一段按天切开的对话。" },
      note: "月报读对话原文。太长时先走分段摘要。",
    };
  }
  if (key === "experiments") {
    const meta = await getMeta();
    const tz = resolveTz(meta.timeZone);
    const month = localDay(now(), tz).slice(0, 7);
    const data = JSON.stringify(await buildReportData(month));
    return {
      slots: { data: data.slice(0, 12_000) },
      note: `用 ${month} 的月报统计。`,
    };
  }
  const charter = await getProfilePrompt();
  return {
    slots: { charter, transcript: LATER },
    note: "评审不跟每一句一起跑。人设是现在这一份，对话要等离线评审。",
  };
}

function render(key: PromptKey, variantId: string, body: string | undefined, slots: Record<string, string>, history: Array<{ role: "user" | "assistant"; content: string }> = []): RenderedMessage[] {
  const spec = promptSpec(key);
  const id = spec.variants.some((variant) => variant.id === variantId) ? variantId : spec.variants[0]?.id ?? "main";
  return renderVariant(parsePromptBody(key, body), id, slots, history);
}

export async function previewPrompt(input: { key: string; variantId?: string; body?: string }): Promise<PromptPreview> {
  if (!isPromptKey(input.key)) throw new Error("unknown-prompt");
  const key = input.key;
  const spec = promptSpec(key);
  const variantId = spec.variants.some((variant) => variant.id === input.variantId) ? input.variantId! : spec.variants[0]?.id ?? "main";
  if (key === "voice") {
    const preview = await voicePreview(input.body);
    return { variantId, ...preview };
  }
  const loaded = await slotsFor(key, variantId);
  return {
    variantId,
    slots: loaded.slots,
    messages: render(key, variantId, input.body, loaded.slots),
    note: loaded.note,
  };
}

import { getSql } from "../../../db.ts";
import { isNightNoiseBody } from "../../message-markup.ts";
import { voiceInjectFromProfile } from "../../types.ts";
import { now } from "../clock.ts";
import { HISTORY_WINDOW, QR_VOICE_READS_DIARY, REFLECT_WINDOW } from "../config.ts";
import { currentArchiveVars } from "../archivist.ts";
import { buildReportData } from "../diary/report.ts";
import {
  getMeta,
  getMind,
  getProfilePrompt,
  listDays,
  listFactors,
  listFindings,
  listHistoryWindow,
  listNotes,
  listNotesByIds,
  listPortrait,
  listThemes,
  listThemeWeeks,
  messagesOnDay,
  openIntentions,
} from "../store.ts";
import { formatClock, localDay } from "../time.ts";
import { resolveTz } from "../tz.ts";
import { isPromptKey, promptSpec, type PromptKey } from "./catalog.ts";
import { parsePromptBody, renderVariant, type RenderedMessage } from "./doc.ts";
import { portraitInputVars } from "../voice/nightly.ts";
import { buildVoiceMessages, formatMemories, voiceFacingSlots, voiceHistoryMessages } from "../voice/pack-build.ts";
import { formatReflectConversation, reflectVars, type ReflectorParts } from "../voice/reflector.ts";
import { getCoreIndexItems, getRelatedIndexItems } from "../voice/retrieve.ts";
import type { Finding } from "../types.ts";

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
  const [meta, portrait, mind, charter, profile] = await Promise.all([
    getMeta(),
    listPortrait(),
    getMind(),
    getProfilePrompt(),
    profileData(),
  ]);
  const tz = resolveTz(meta.timeZone);
  const inject = voiceInjectFromProfile({
    injectMemories: profile.injectMemories !== false,
    injectLongterm: profile.injectLongterm !== false,
    historyWindow: typeof profile.historyWindow === "number" ? profile.historyWindow : HISTORY_WINDOW,
  });
  const history = await listHistoryWindow(null, inject.history);
  const ids = mind.memory_ids ?? [];
  let notes = ids.length ? (await listNotesByIds(ids)).filter((note) => note.status === "active") : [];
  if (!notes.length) notes = (await listNotes({ status: "active", limit: 6 })).slice(0, 6);
  const clock = formatClock(now(), tz);
  const facing = voiceFacingSlots({
    selfSummary: meta.selfSummary,
    bondSummary: meta.bondSummary,
    portrait,
    mind: mind.insight,
    memories: formatMemories(notes, tz),
  });
  const historyText =
    voiceHistoryMessages(history, inject.history)
      .map((message) => `${message.role === "user" ? "user" : "assistant"}：${message.content}`)
      .join("\n") || "（没有对话）";
  const messages = buildVoiceMessages({
    charter,
    selfSummary: meta.selfSummary,
    bondSummary: meta.bondSummary,
    portrait,
    history,
    userText: "在吗",
    mind,
    notes,
    clock,
    timeZone: tz,
    nowMs: now(),
    voiceTemplate: body,
    inject,
  });
  return {
    slots: {
      ...facing,
      mind: facing.mind || "（空，这一轮不会放【内心】）",
      system_prompt: charter,
      clock,
      user_text: "在吗",
      history_messages: historyText,
    },
    messages,
    note: "没有正在说的这一句，用户消息用「在吗」占位。记忆、画像、内心是发给回复模型前的文本，库里原文没改。",
  };
}

function findingLine(f: Finding, nameOf: (id: string) => string): string {
  return f.kind === "recovery"
    ? `- 「${nameOf(f.outcomeId)}」期间出现「${nameOf(f.antecedentId)}」后，常在 1–2 天内好转（${f.n11} 次）`
    : `- 「${nameOf(f.antecedentId)}」之后${f.lag ? ` ${f.lag} 天内` : "当天"}常出现「${nameOf(f.outcomeId)}」（${f.n11} 次，是平时的 ${f.lift.toFixed(1)} 倍）`;
}

async function reflectSlots(): Promise<Record<string, string>> {
  const [meta, history, portrait, charter, mind] = await Promise.all([
    getMeta(),
    listHistoryWindow(null, REFLECT_WINDOW),
    listPortrait(),
    getProfilePrompt(),
    getMind(),
  ]);
  const tz = resolveTz(meta.timeZone);
  const day = localDay(now(), tz);
  const coreIndex = await getCoreIndexItems(day);
  const coreIds = new Set(coreIndex.map((item) => item.id));
  const rosieLast = history
    .filter((message) => message.role === "user" && !isNightNoiseBody(message.text))
    .slice(-4)
    .map((message) => message.text);
  const relatedIndex = await getRelatedIndexItems([...rosieLast, mind.insight].filter(Boolean).join("\n"), coreIds);
  const themesPacked: ReflectorParts["themes"] = [];
  const findingsPacked: Array<{ id: string; line: string }> = [];
  if (QR_VOICE_READS_DIARY) {
    const [themes, findings, weeks, factors] = await Promise.all([
      listThemes(true),
      listFindings(),
      listThemeWeeks(),
      listFactors(false),
    ]);
    const factorName = new Map(factors.map((factor) => [factor.id, factor.name]));
    const nameOf = (id: string) => factorName.get(id) ?? id;
    const weekMap = new Map<string, string>();
    for (const week of weeks.slice().sort((a, b) => b.week.localeCompare(a.week))) {
      if (!weekMap.has(week.themeId)) weekMap.set(week.themeId, `${week.week} 提到 ${week.mentions} 次`);
    }
    for (const theme of themes
      .filter((row) => row.userFeedback !== "rejected")
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 8)) {
      themesPacked.push({ ...theme, weekHint: weekMap.get(theme.id) });
    }
    for (const finding of findings
      .filter((row) => row.userFeedback !== "rejected" && row.kind !== "cooccur" && row.tier === "finding")
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 5)) {
      findingsPacked.push({ id: finding.id, line: findingLine(finding, nameOf) });
    }
  }
  return reflectVars({
    charter,
    selfSummary: meta.selfSummary,
    bondSummary: meta.bondSummary,
    portrait,
    themes: themesPacked,
    findings: findingsPacked,
    coreIndex,
    clock: formatClock(now(), tz),
    relatedIndex,
    oldMind: mind,
    conversation: formatReflectConversation(history, tz),
  });
}

async function portraitSlots(): Promise<Record<string, string>> {
  return portraitInputVars();
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
  if (key === "portrait") return { slots: await portraitSlots(), note: "用最近 30 天的笔记、现在的画像和最近的对话。" };
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
  if (key === "report" || key === "experiments") {
    const meta = await getMeta();
    const tz = resolveTz(meta.timeZone);
    const month = localDay(now(), tz).slice(0, 7);
    const data = JSON.stringify(await buildReportData(month));
    return {
      slots: { data: data.slice(0, key === "report" ? 20_000 : 12_000) },
      note: `用 ${month} 的月报统计。`,
    };
  }
  const charter = await getProfilePrompt();
  return {
    slots: { charter, transcript: LATER },
    note: "评审不在通话里跑。人设是现在这一份，对话要等离线评审。",
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

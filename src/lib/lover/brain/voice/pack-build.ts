import { HISTORY_WINDOW, PORTRAIT_MAX_CHARS, SESSION_GAP_MS } from "../config.ts";
import { formatClock } from "../time.ts";
import { formatMindAge } from "../usage.ts";
import type { Mind, Note, PortraitRow, StoredMessage, VoiceChatMessage } from "../types.ts";
import { EMPTY_MIND } from "../types.ts";
import { QINGRAN_STANCE_ONE_LINE } from "./prompts.ts";
import { hearingTagGuide } from "../../prompt.ts";
import { modelFacingText } from "../../message-markup.ts";

function mindIsEmpty(mind: Mind): boolean {
  return (
    !mind.rosie_now &&
    !mind.undercurrent &&
    !mind.my_feel &&
    !mind.my_view &&
    !mind.my_logic &&
    !mind.intent &&
    mind.lead_plan.length === 0
  );
}

function portraitBlock(rows: PortraitRow[]): string {
  const active = rows.filter((r) => r.status === "active");
  if (!active.length) return "（还在慢慢认识她）";
  const lines = active.map((r) => `${r.topic}：${r.body}`);
  let text = lines.join("\n");
  if (text.length > PORTRAIT_MAX_CHARS) text = `${text.slice(0, PORTRAIT_MAX_CHARS - 1)}…`;
  return text;
}

export function renderVoiceLongterm(selfSummary: string, bondSummary: string, portrait: PortraitRow[]): string {
  return `【我自己】${selfSummary || "（还在过自己的日子）"}
【我们】${bondSummary || "（还在一点点建立）"}
【我眼中的她】${portraitBlock(portrait)}`;
}

function formatMemories(notes: Note[], timeZone: string): string {
  if (!notes.length) return "（这一刻没有特别要提起的）";
  return notes
    .map((n) => {
      const md = n.localDay.slice(5) || formatClock(n.happenedAt, timeZone).slice(0, 10);
      return `${md} ${n.text}`;
    })
    .join("\n");
}

export const VOICE_THIN_HISTORY = 8;
export type VoiceStrip = "none" | "mind" | "notes" | "thin";
export const VOICE_STRIPS: VoiceStrip[] = ["none", "mind", "notes", "thin"];

export type VoicePackParts = {
  charter: string;
  longterm: string;
  history: StoredMessage[];
  userText: string;
  mind: Mind;
  notes: Note[];
  clockText: string;
  timeZone: string;
  careHint: boolean;
  nowMs: number;
  mindStale: boolean;
  jump: boolean;
};

export type VoiceInputChars = {
  system: number;
  mind: number;
  notes: number;
  history: number;
  user: number;
};

export function systemCharter(charter: string): string {
  return (charter.trim() || "你就是清然。正在和 Rosie 语音通话。") + "\n\n" + hearingTagGuide();
}

export function voiceMessagesForStrip(parts: VoicePackParts, strip: VoiceStrip): VoiceChatMessage[] {
  if (strip === "thin") {
    const history = parts.history.slice(-VOICE_THIN_HISTORY).map((m) => ({
      role: m.role as "user" | "assistant",
      content: modelFacingText(m.text),
    }));
    return [
      { role: "system", content: systemCharter(parts.charter) },
      ...history,
      { role: "user", content: parts.userText },
    ];
  }
  const mind = strip === "none" ? parts.mind : EMPTY_MIND;
  const notes = strip === "none" || strip === "mind" ? parts.notes : [];
  const tail = buildTail({
    clock: parts.clockText,
    mind,
    notes,
    timeZone: parts.timeZone,
    careHint: parts.careHint,
    nowMs: parts.nowMs,
    stale: parts.mindStale && Boolean(parts.mind.updated_at) && parts.mind.turn_seq > 0,
    jump: parts.jump,
  });
  return buildVoiceMessages({
    charter: parts.charter,
    longterm: parts.longterm,
    history: parts.history,
    tail,
    userText: parts.userText,
  });
}

export function voiceInputChars(parts: VoicePackParts): VoiceInputChars {
  const system = systemCharter(parts.charter).length;
  const tailMind = buildTail({
    clock: parts.clockText,
    mind: parts.mind,
    notes: [],
    timeZone: parts.timeZone,
    careHint: false,
    nowMs: parts.nowMs,
    stale: parts.mindStale,
    jump: parts.jump,
  });
  const tailBare = buildTail({
    clock: parts.clockText,
    mind: EMPTY_MIND,
    notes: [],
    timeZone: parts.timeZone,
    careHint: false,
    nowMs: parts.nowMs,
    stale: false,
    jump: false,
  });
  const tailNotes = buildTail({
    clock: parts.clockText,
    mind: EMPTY_MIND,
    notes: parts.notes,
    timeZone: parts.timeZone,
    careHint: false,
    nowMs: parts.nowMs,
    stale: false,
    jump: false,
  });
  return {
    system,
    mind: Math.max(0, tailMind.length - tailBare.length),
    notes: Math.max(0, tailNotes.length - tailBare.length),
    history: parts.history.reduce((n, m) => n + modelFacingText(m.text).length, 0),
    user: parts.userText.length,
  };
}

export function formatVoiceInputCharsLine(c: VoiceInputChars): string {
  return `chars system=${c.system} mind=${c.mind} notes=${c.notes} history=${c.history} user=${c.user}`;
}

export function parseVoiceInputCharsLine(note: string | null | undefined): VoiceInputChars | null {
  const m = (note ?? "").match(/chars system=(\d+) mind=(\d+) notes=(\d+) history=(\d+) user=(\d+)/);
  if (!m) return null;
  return {
    system: Number(m[1]),
    mind: Number(m[2]),
    notes: Number(m[3]),
    history: Number(m[4]),
    user: Number(m[5]),
  };
}

export function stripLabel(strip: VoiceStrip): string {
  if (strip === "mind") return "去掉了 mind";
  if (strip === "notes") return "去掉了 mind 和记忆笔记";
  if (strip === "thin") return "只保留 system prompt、最近 8 条对话和用户消息";
  return "未裁剪";
}

function readingLine(mind: Mind): string {
  if (!mind.reading.length) return "";
  return mind.reading
    .map((r) => `${r.guess}（把握 ${Math.round(r.conf * 100)}%）`)
    .join("；");
}

export function buildTail(opts: {
  clock: string;
  mind: Mind;
  notes: Note[];
  timeZone: string;
  careHint: boolean;
  nowMs?: number;
  stale?: boolean;
  jump?: boolean;
}): string {
  let reading = readingLine(opts.mind);
  let threads = opts.mind.threads.join("；");
  const core = {
    lead: opts.mind.lead_plan.join(" → "),
    intent: opts.mind.intent,
  };
  const mindAge = (opts.nowMs ?? 0) - (opts.mind.updated_at ?? 0);
  const stale =
    opts.stale ??
    (!mindIsEmpty(opts.mind) && Boolean(opts.nowMs) && Boolean(opts.mind.updated_at) && mindAge > SESSION_GAP_MS);
  const jump = Boolean(opts.jump) && !stale && !mindIsEmpty(opts.mind);
  const innerHint = jump
    ? "（这是你上一刻的想法，但她刚跳到了新的话题。以她这句话为准，先跟上她，再决定要不要把上面那条路走回来。）"
    : "（这是你上一刻的想法；如果她这句话改变了情况，以这句话为准。说不说出来、怎么说，由你判断。）";
  const jumpRoad = jump ? "上面这条路可能不适用了。\n" : "";

  const inner = mindIsEmpty(opts.mind)
    ? ""
    : stale
      ? `【你上次的内心】（这是 ${formatMindAge(mindAge)}前的想法，她现在的状态可能已经变了）
底下的东西：${opts.mind.undercurrent}
你的推断：${reading}
你的看法：${opts.mind.my_view}
你要带她走的路：${core.lead}
要跟进：${threads}
先重新感受她现在的状态，再决定怎么带她。

`
      : `【你此刻的内心】${innerHint}
她现在：${opts.mind.rosie_now}
底下的东西：${opts.mind.undercurrent}
你的推断：${reading}
${opts.mind.soft_spot ? `心软的地方：${opts.mind.soft_spot}\n` : ""}你的感受：${opts.mind.my_feel}
你的看法：${opts.mind.my_view}
你的思路：${opts.mind.my_logic}
你要带她走的路：${core.lead}
这一句：${core.intent}
${jumpRoad}要跟进：${threads}

`;

  let tail = `现在是${opts.clock}。

${inner}【可以用的记忆】
${formatMemories(opts.notes, opts.timeZone)}

${QINGRAN_STANCE_ONE_LINE}
说话要有逻辑：观点有依据，前后一致。`;

  if (opts.careHint) {
    tail += "\n如果时机自然，可以像平常关心一样问问她今天过得怎么样、睡得如何。";
  }

  if (tail.length > 2400 && !mindIsEmpty(opts.mind) && !stale) {
    reading = "";
    threads = "";
    tail = `现在是${opts.clock}。

【你此刻的内心】${innerHint}
她现在：${opts.mind.rosie_now}
底下的东西：${opts.mind.undercurrent}
你的感受：${opts.mind.my_feel}
你的看法：${opts.mind.my_view}
你的思路：${opts.mind.my_logic}
你要带她走的路：${core.lead}
这一句：${core.intent}
${jumpRoad}
【可以用的记忆】
${formatMemories(opts.notes, opts.timeZone)}

${QINGRAN_STANCE_ONE_LINE}
说话要有逻辑：观点有依据，前后一致。`;
  }
  return tail;
}

export function buildVoiceMessages(opts: {
  charter: string;
  selfSummary?: string;
  bondSummary?: string;
  portrait?: PortraitRow[];
  longterm?: string;
  history: StoredMessage[];
  tail: string;
  userText: string;
}): VoiceChatMessage[] {
  const charter = systemCharter(opts.charter);
  const long =
    opts.longterm ??
    renderVoiceLongterm(opts.selfSummary ?? "", opts.bondSummary ?? "", opts.portrait ?? []);
  const history = opts.history.slice(-HISTORY_WINDOW).map((m) => ({
    role: m.role as "user" | "assistant",
    content: modelFacingText(m.text),
  }));
  return [
    { role: "system", content: charter },
    { role: "system", content: long },
    ...history,
    { role: "system", content: opts.tail },
    { role: "user", content: opts.userText },
  ];
}

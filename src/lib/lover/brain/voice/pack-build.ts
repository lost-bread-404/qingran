import { HISTORY_WINDOW, PORTRAIT_MAX_CHARS, SESSION_GAP_MS } from "../config.ts";
import { formatClock } from "../time.ts";
import { formatMindAge } from "../usage.ts";
import type { Mind, Note, PortraitRow, StoredMessage, VoiceChatMessage } from "../types.ts";
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
  const charter = (opts.charter.trim() || "你就是清然。正在和 Rosie 语音通话。") + "\n\n" + hearingTagGuide();
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

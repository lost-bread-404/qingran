/**
 * Every speech tag xAI's voice documents (docs.x.ai text-to-speech), each on the same line, so she can hear which ones
 * Eve really reads. Inline tags sit between the two sentences; wrapping tags wrap both. Two cases read the line the way
 * a reply streams (in two pieces, the tag cut at the full stop). Shared by the lab page and the server that reads them.
 */
const LINE_A = "姐姐抱着你，哪儿都不去。";
const LINE_B = "睡吧。";

import { INLINE_TAGS as INLINE, WRAP_TAGS as WRAP } from "./speech-tags";

export type ToneCase = { id: string; how: string; mode: "http" | "ws"; parts: string[] };


export const TONE_CASES: ToneCase[] = [
  { id: "plain", how: "没有标签", mode: "http", parts: [LINE_A + LINE_B] },
  ...WRAP.map((t): ToneCase => ({ id: t, how: `<${t}>`, mode: "http", parts: [`<${t}>${LINE_A}${LINE_B}</${t}>`] })),
  ...INLINE.map((t): ToneCase => ({ id: t, how: `[${t}]`, mode: "http", parts: [`${LINE_A}[${t}] ${LINE_B}`] })),
  { id: "ws_plain", how: "边写边读，没有标签", mode: "ws", parts: [LINE_A, LINE_B] },
  { id: "ws_whisper_split", how: "边写边读，<whisper> 在句号处切开（聊天里就这样）", mode: "ws", parts: [`<whisper>${LINE_A}`, `${LINE_B}</whisper>`] },
];

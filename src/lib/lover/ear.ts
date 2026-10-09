/**
 * How her voice is heard (requirements 第 7 节). Her voice streams to xAI's recognizer while she speaks, and nothing
 * here guesses from loudness:
 * - hold to talk: she decides where a line starts and ends (press, release);
 * - a call: xAI's turn model decides when a sentence is finished.
 * The browser reaches xAI through server/routes/api/listen.ts, the iPhone shell with a ticket from /api/stt-stream;
 * both ask for the same stream, built here. /api/stt reads a whole clip, only when the stream could not be opened.
 */

export const EAR_MODEL = "grok-voice-transcribe-2.0";
export const EAR_STREAM_URL = "wss://api.x.ai/v1/stt";
export const EAR_CLIP_URL = "https://api.x.ai/v1/stt";

export type EarMode = "hold" | "call";

/** No mode: an iPhone shell from before 2026-10-06, which streams only in calls. */
export function earMode(value: unknown): EarMode {
  return value === "hold" ? "hold" : "call";
}

/** Words xAI should lean toward (设置 → 声音和听力 → 容易听错的词). Only what she wrote: nothing is added from the talk. */
export const DEFAULT_KEYTERMS: readonly string[] = ["清然", "姐姐", "小猫", "Rosie", "林泽"];

/** Her list, or the default when she never saved one. At most 100 words of at most 50 characters (xAI's limits). */
export function lockKeyterms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_KEYTERMS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const term = item.trim().slice(0, 50);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= 100) break;
  }
  return out;
}

/** In a call: how long a pause may be before the line ends, however unfinished it sounds (her 「停多久算说完」). */
export const CALL_WAIT_MIN = 800;
export const CALL_WAIT_MAX = 3000;
export const CALL_WAIT_DEFAULT = 2000;

export function clampCallWait(value: unknown, fallback = CALL_WAIT_DEFAULT): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(CALL_WAIT_MAX, Math.max(CALL_WAIT_MIN, Math.round(n / 100) * 100));
}

/**
 * The stream's settings. Both modes get live words (interim_results) and keep 嗯 / 啊 (filler_words).
 * A call also gets xAI's turn model (smart_turn): a pause in the middle of a sentence does not end it; her wait is the
 * longest pause it allows. In a call the room is heard the whole time, so only sound that is likely speech counts
 * (vad_threshold 0.3; she sleeps with the call on). Holding to talk is her own signal, so xAI's default gate stays and
 * her soft 嗯 and breath are kept.
 */
export function earQuery(mode: EarMode, opts: { wait?: unknown; keyterms?: readonly string[] }): string {
  const pairs: Array<[string, string]> = [
    ["model", EAR_MODEL],
    ["sample_rate", "16000"],
    ["encoding", "pcm"],
    ["interim_results", "true"],
    ["filler_words", "true"],
  ];
  if (mode === "call") {
    pairs.push(
      ["vad_threshold", "0.3"],
      ["endpointing", "500"],
      ["smart_turn", "0.7"],
      ["smart_turn_timeout", String(clampCallWait(opts.wait))],
    );
  }
  let query = pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  for (const term of lockKeyterms(opts.keyterms ?? [])) {
    let next: string;
    try {
      next = `${query}&keyterm=${encodeURIComponent(term)}`;
    } catch {
      continue; // half of an emoji (cut at 50 characters) cannot be encoded
    }
    if (next.length > 7000) break;
    query = next;
  }
  return query;
}

/**
 * What she said, as shown and sent: xAI's own ~ shown as ～ (requirements 第 7 节), and a line the recognizer wrote
 * twice in a row kept once. Only a long line counts as written twice; her own 「好吧好吧」「不是你的不是你的」 stay.
 */
export function tidyHeard(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim().replace(/~+/g, "～");
  const mark = /[\s，。！？、,.!?…～]/;
  const core = [...text].filter((ch) => !mark.test(ch));
  if (core.length < 12 || core.length % 2) return text;
  const half = core.length / 2;
  if (core.slice(0, half).join("") !== core.slice(half).join("")) return text;
  const chars = [...text];
  let seen = 0;
  for (let i = 0; i < chars.length; i += 1) {
    if (!mark.test(chars[i]!)) seen += 1;
    if (seen === half) {
      let end = i + 1;
      while (end < chars.length && mark.test(chars[end]!) && chars[end] !== " ") end += 1;
      return chars.slice(0, end).join("");
    }
  }
  return text;
}

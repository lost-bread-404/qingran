import { z } from "zod";

export const CONTOURS = ["rising", "falling", "flat", "wavering"] as const;
export const LENGTHS = ["short", "long"] as const;
export const VOICES = ["normal", "breathy", "whisper"] as const;
export const EMOTIONS = [
  "coy",
  "playful",
  "content",
  "sleepy",
  "sad",
  "annoyed",
  "neutral",
] as const;
export const EVENTS = ["laugh", "cry", "breath", "sigh"] as const;

export type CueContour = (typeof CONTOURS)[number];
export type CueLength = (typeof LENGTHS)[number];
export type CueVoice = (typeof VOICES)[number];
export type CueEmotion = (typeof EMOTIONS)[number];
export type CueEvent = (typeof EVENTS)[number];

export type HearingCue = {
  token: string;
  contour: CueContour;
  length: CueLength;
  voice: CueVoice;
  emotion: CueEmotion;
  event?: CueEvent;
};

export const hearingCueSchema = z.object({
  token: z.string().min(1).max(40),
  contour: z.enum(CONTOURS),
  length: z.enum(LENGTHS),
  voice: z.enum(VOICES),
  emotion: z.enum(EMOTIONS),
  event: z.enum(EVENTS).optional(),
});

export const hearingModelSchema = z.object({
  text: z.string(),
  cues: z.array(hearingCueSchema).max(32),
  utterance_emotion: z.enum(EMOTIONS),
  noise_only: z.boolean(),
});

export type HearingModelOutput = z.infer<typeof hearingModelSchema>;

export type HearingResult = HearingModelOutput & {
  raw: string;
  latency_ms: number;
  provider: string;
  model: string;
  fallback_from?: string;
  fallback_reason?: string;
  refusal: boolean;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  cold_start_ms?: number;
};

const TAG_RE = /〔[^〕]*〕/g;

export function stripCueTags(text: string): string {
  return text.replace(TAG_RE, "");
}

export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export function looksLikeRefusal(raw: string): boolean {
  const text = raw.trim();
  if (!text) return true;
  if (text.startsWith("{") || text.includes("```")) return false;
  return /sorry|cannot|can't|unable|i'm not able|无法|不能转写|拒绝|对不起/i.test(text);
}

export function parseHearingJson(raw: string): HearingModelOutput {
  const parsed = JSON.parse(extractJsonObject(raw)) as unknown;
  return hearingModelSchema.parse(normalizeHearingJson(parsed));
}

function normalizeHearingJson(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const cues = Array.isArray(row.cues)
    ? row.cues.map((cue) => {
        if (!cue || typeof cue !== "object") return cue;
        const item = cue as Record<string, unknown>;
        const next = { ...item };
        if (next.event === "" || next.event === null) delete next.event;
        if (typeof next.token === "string") next.token = next.token.trim();
        return next;
      })
    : row.cues;
  return {
    text: typeof row.text === "string" ? row.text : "",
    cues,
    utterance_emotion: row.utterance_emotion ?? "neutral",
    noise_only: Boolean(row.noise_only),
  };
}

export function formatTaggedText(result: HearingModelOutput): string {
  const text = result.text.trim();
  if (result.noise_only) return "";
  if (!text && result.cues.length === 0) return "";
  if (!result.cues.length) {
    return result.utterance_emotion === "neutral"
      ? text
      : `${text}〔｜${result.utterance_emotion}〕`;
  }

  let used = text;
  const leftover: HearingCue[] = [];
  for (const cue of result.cues) {
    const tag = formatCueTag(cue);
    const idx = used.indexOf(cue.token);
    if (idx < 0) {
      leftover.push(cue);
      continue;
    }
    const insertAt = idx + cue.token.length;
    used = `${used.slice(0, insertAt)}${tag}${used.slice(insertAt)}`;
  }
  for (const cue of leftover) {
    used += `${cue.token}${formatCueTag(cue)}`;
  }
  const last = result.cues[result.cues.length - 1];
  if (result.utterance_emotion !== "neutral" && last?.emotion !== result.utterance_emotion) {
    used += `〔｜${result.utterance_emotion}〕`;
  }
  return used.trim();
}

export function formatCueTag(cue: HearingCue): string {
  const left = [cue.length, cue.contour, cue.voice].join("·");
  const right = cue.event ? `${cue.emotion}·${cue.event}` : cue.emotion;
  return `〔${left}｜${right}〕`;
}

export function emptyHearing(provider: string, model: string, latency_ms: number): HearingResult {
  return {
    text: "",
    cues: [],
    utterance_emotion: "neutral",
    noise_only: true,
    raw: "",
    latency_ms,
    provider,
    model,
    refusal: false,
  };
}

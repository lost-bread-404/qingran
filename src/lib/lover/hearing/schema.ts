import { z } from "zod";
import { applyAltTags } from "./nbest.ts";

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
export const EVENTS = ["laugh", "cry", "breath", "sigh", "moan", "meow", "coy"] as const;

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

export const hearingAlternativeSchema = z.object({
  span: z.string().min(1).max(40),
  candidates: z.array(z.string().min(1).max(40)).min(2).max(2),
});

export const hearingModelSchema = z.object({
  text: z.string(),
  cues: z.array(hearingCueSchema).max(32),
  utterance_emotion: z.enum(EMOTIONS),
  noise_only: z.boolean(),
  alternatives: z.array(hearingAlternativeSchema).max(2).optional(),
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

export function formatTaggedText(result: HearingModelOutput): string {
  const text = result.text.trim();
  if (result.noise_only) return "";
  if (!text && result.cues.length === 0) return "";
  let used = text || result.cues.map((cue) => cue.token).join("");
  if (result.alternatives?.length) used = applyAltTags(used, result.alternatives);
  return used.trim();
}


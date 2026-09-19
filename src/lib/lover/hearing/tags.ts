import { listenVocal } from "../vocal-event.ts";
import { voicedIslands, type ProsodyFrame } from "../prosody.ts";

export const TAG_LENGTHS = ["short", "long"] as const;
export const TAG_CONTOURS = ["rising", "falling", "flat", "wavering"] as const;
export const TAG_VOICES = ["normal", "breathy"] as const;
export const TAG_EVENTS = ["none", "laugh", "cry", "sigh"] as const;
export const TAG_KEYS = ["length", "contour", "voice", "event"] as const;

export type TagLength = (typeof TAG_LENGTHS)[number];
export type TagContour = (typeof TAG_CONTOURS)[number];
export type TagVoice = (typeof TAG_VOICES)[number];
export type TagEvent = (typeof TAG_EVENTS)[number];
export type TagKey = (typeof TAG_KEYS)[number];

export type AcousticTags = {
  length: TagLength;
  contour: TagContour;
  voice: TagVoice;
  event: TagEvent;
};

export const TAG_LABELS: Record<TagKey, string> = {
  length: "长短",
  contour: "走向",
  voice: "声线",
  event: "事件",
};

export const TAG_VALUE_LABELS: {
  length: Record<TagLength, string>;
  contour: Record<TagContour, string>;
  voice: Record<TagVoice, string>;
  event: Record<TagEvent, string>;
} = {
  length: { short: "短", long: "长" },
  contour: { rising: "升", falling: "降", flat: "平", wavering: "晃" },
  voice: { normal: "正常", breathy: "气声" },
  event: { none: "无", laugh: "笑", cry: "哭", sigh: "叹" },
};

const TAG_RE = /〔[^〕]*〕/g;

export function defaultTags(): AcousticTags {
  return { length: "short", contour: "flat", voice: "normal", event: "none" };
}

export function isTagLength(value: unknown): value is TagLength {
  return value === "short" || value === "long";
}
export function isTagContour(value: unknown): value is TagContour {
  return value === "rising" || value === "falling" || value === "flat" || value === "wavering";
}
export function isTagVoice(value: unknown): value is TagVoice {
  return value === "normal" || value === "breathy";
}
export function isTagEvent(value: unknown): value is TagEvent {
  return value === "none" || value === "laugh" || value === "cry" || value === "sigh";
}

export function parseAcousticTags(value: unknown): AcousticTags | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const voice = row.voice === "whisper" ? "breathy" : row.voice;
  if (!isTagLength(row.length) || !isTagContour(row.contour) || !isTagVoice(voice) || !isTagEvent(row.event)) {
    return null;
  }
  return { length: row.length, contour: row.contour, voice, event: row.event };
}

export function parseTagKeys(value: unknown): TagKey[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TagKey => TAG_KEYS.includes(item as TagKey));
}

export function tagsTouched(predicted: AcousticTags, chosen: AcousticTags): TagKey[] {
  return TAG_KEYS.filter((key) => predicted[key] !== chosen[key]);
}

export function goldTagsFromTouched(chosen: AcousticTags, touched: TagKey[]): Partial<AcousticTags> {
  const gold: Partial<AcousticTags> = {};
  for (const key of touched) {
    switch (key) {
      case "length":
        gold.length = chosen.length;
        break;
      case "contour":
        gold.contour = chosen.contour;
        break;
      case "voice":
        gold.voice = chosen.voice;
        break;
      case "event":
        gold.event = chosen.event;
        break;
    }
  }
  return gold;
}

export function formatAcousticTag(tags: AcousticTags): string {
  const right = tags.event === "none" ? "" : tags.event;
  return `〔${tags.length}·${tags.contour}·${tags.voice}｜${right}〕`;
}

export function stripAcousticTags(text: string): string {
  return text.replace(TAG_RE, "");
}

export function applyUtteranceTag(text: string, tags: AcousticTags | null | undefined): string {
  const core = stripAcousticTags(text).trim();
  if (!core) return "";
  if (!tags) return core;
  return `${core}${formatAcousticTag(tags)}`;
}

export function tagsFromCues(
  cues: Array<{ length?: string; contour?: string; voice?: string; event?: string | null }>,
): AcousticTags {
  const tags = defaultTags();
  if (!cues.length) return tags;
  if (cues.some((cue) => cue.length === "long")) tags.length = "long";
  else if (cues.some((cue) => cue.length === "short")) tags.length = "short";

  const contours = cues.map((cue) => cue.contour).filter(isTagContour);
  const unique = new Set(contours);
  if (unique.size >= 3) tags.contour = "wavering";
  else if (unique.size === 2) tags.contour = unique.has("wavering") ? "wavering" : contours[contours.length - 1]!;
  else if (contours[0]) tags.contour = contours[0];

  if (cues.some((cue) => cue.voice === "breathy" || cue.voice === "whisper")) tags.voice = "breathy";

  for (const cue of cues) {
    if (cue.event === "laugh") {
      tags.event = "laugh";
      break;
    }
    if (cue.event === "cry") {
      tags.event = "cry";
      break;
    }
    if (cue.event === "sigh" || cue.event === "breath") {
      tags.event = "sigh";
      break;
    }
  }
  return tags;
}

export function predictUtteranceTags(input: {
  cues?: Array<{ length?: string; contour?: string; voice?: string; event?: string | null }>;
  frames?: ProsodyFrame[];
}): AcousticTags {
  if (input.cues?.length) return tagsFromCues(input.cues);
  if (input.frames?.length) return tagsFromProsody(input.frames);
  return defaultTags();
}

export function tagsFromProsody(frames: ProsodyFrame[]): AcousticTags {
  const tags = defaultTags();
  if (!frames.length) return tags;
  const islands = voicedIslands(frames);
  const dur =
    islands.length > 0
      ? islands.reduce((sum, island) => sum + Math.max(0, island.end - island.start), 0)
      : Math.max(0, (frames.at(-1)?.t ?? 0) - (frames[0]?.t ?? 0));
  tags.length = dur >= 0.42 ? "long" : "short";

  const voiced = frames.filter((f) => f.hz > 80 && f.clarity >= 0.6);
  const hz = voiced.map((f) => f.hz);
  if (hz.length >= 3) {
    const third = Math.max(1, Math.ceil(hz.length / 3));
    const startHz = avg(hz.slice(0, third));
    const endHz = avg(hz.slice(-third));
    const rise = startHz > 80 ? endHz / startHz : 1;
    const jitter = cv(hz);
    if (jitter >= 0.2 && rise < 1.14 && rise > 0.88) tags.contour = "wavering";
    else if (rise >= 1.12) tags.contour = "rising";
    else if (rise <= 0.9) tags.contour = "falling";
    else tags.contour = "flat";
  }

  const rms = frames.map((f) => f.rms);
  const peak = Math.max(0, ...rms);
  const loud = frames.filter((f) => f.rms >= 0.006);
  const voicedShare = voiced.length / Math.max(1, loud.length);
  const meanBright = avg(frames.map((f) => f.bright));
  if (voicedShare <= 0.38 && meanBright >= 0.16) tags.voice = "breathy";

  const vocal = listenVocal(frames);
  if (vocal.kind === "laugh") tags.event = "laugh";
  else if (vocal.kind === "cry") tags.event = "cry";
  else {
    const third = Math.max(1, Math.ceil(rms.length / 3));
    const head = avg(rms.slice(0, third));
    const tail = avg(rms.slice(-third));
    if (dur >= 0.28 && peak < 0.045 && head > 0 && tail < head * 0.72) tags.event = "sigh";
  }
  return tags;
}

export type TagAccuracy = Record<TagKey, number | null>;

export function scoreTagAccuracy(
  clips: Array<{
    predictedTags?: AcousticTags | null;
    goldTags?: Partial<AcousticTags> | null;
    tagsTouched?: TagKey[] | null;
  }>,
): TagAccuracy {
  const out: TagAccuracy = { length: null, contour: null, voice: null, event: null };
  for (const key of TAG_KEYS) {
    let hit = 0;
    let n = 0;
    for (const clip of clips) {
      if (!clip.tagsTouched?.includes(key)) continue;
      const gold = clip.goldTags?.[key];
      const predicted = clip.predictedTags?.[key];
      if (!gold || !predicted) continue;
      n += 1;
      if (gold === predicted) hit += 1;
    }
    out[key] = n ? hit / n : null;
  }
  return out;
}

function avg(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function cv(values: number[]) {
  if (values.length < 2) return 0;
  const mean = avg(values);
  if (mean <= 0) return 0;
  return Math.sqrt(avg(values.map((n) => (n - mean) ** 2))) / mean;
}

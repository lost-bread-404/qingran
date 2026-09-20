import { voicedIslands, type ProsodyFrame } from "../prosody.ts";

export const TAG_LENGTHS = ["short", "long"] as const;
export const TAG_CONTOURS = ["rising", "falling", "flat", "wavering"] as const;
export const TAG_VOICES = ["normal", "breathy"] as const;
export const TAG_EVENT_VALUES = ["laugh", "cry", "sigh", "moan", "meow", "coy"] as const;
export const EVENT_CHIP_VALUES = ["none", ...TAG_EVENT_VALUES] as const;
export const TAG_KEYS = ["length", "contour", "voice", "events"] as const;

export type TagLength = (typeof TAG_LENGTHS)[number];
export type TagContour = (typeof TAG_CONTOURS)[number];
export type TagVoice = (typeof TAG_VOICES)[number];
export type TagEvent = (typeof TAG_EVENT_VALUES)[number];
export type EventChip = (typeof EVENT_CHIP_VALUES)[number];
export type TagKey = (typeof TAG_KEYS)[number];

export type AcousticTags = {
  length?: TagLength;
  contour?: TagContour;
  voice?: TagVoice;
  events?: TagEvent[];
};

export const TAG_LABELS: Record<TagKey, string> = {
  length: "长短",
  contour: "走向",
  voice: "声线",
  events: "事件",
};

export const TAG_VALUE_LABELS: {
  length: Record<TagLength, string>;
  contour: Record<TagContour, string>;
  voice: Record<TagVoice, string>;
  events: Record<TagEvent, string>;
} = {
  length: { short: "短", long: "长" },
  contour: { rising: "升", falling: "降", flat: "平", wavering: "晃" },
  voice: { normal: "正常", breathy: "气声" },
  events: { laugh: "笑", cry: "哭", sigh: "叹", moan: "喘", meow: "猫叫", coy: "撒娇" },
};

export const EVENT_CHIP_LABELS: Record<EventChip, string> = {
  none: "无",
  laugh: "笑",
  cry: "哭",
  sigh: "叹",
  moan: "喘",
  meow: "猫叫",
  coy: "撒娇",
};

const TAG_RE = /〔[^〕]*〕/g;

export function defaultTags(): AcousticTags {
  return { length: "short", contour: "flat", voice: "normal", events: [] };
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
  return (
    value === "laugh" ||
    value === "cry" ||
    value === "sigh" ||
    value === "moan" ||
    value === "meow" ||
    value === "coy"
  );
}

export function uniqueEvents(values: readonly unknown[]): TagEvent[] {
  const set = new Set<TagEvent>();
  for (const value of values) {
    if (isTagEvent(value)) set.add(value);
  }
  return TAG_EVENT_VALUES.filter((event) => set.has(event));
}

export function eventsEqual(a: readonly TagEvent[] | undefined, b: readonly TagEvent[] | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return uniqueEvents(a).join("+") === uniqueEvents(b).join("+");
}

export function normalizeEvents(value: unknown): TagEvent[] {
  if (Array.isArray(value)) return uniqueEvents(value);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none") return [];
  return uniqueEvents(trimmed.split(/[+,\s]+/));
}

export function cueEventToTag(event: string | null | undefined): TagEvent | null {
  if (
    event === "laugh" ||
    event === "cry" ||
    event === "sigh" ||
    event === "moan" ||
    event === "meow" ||
    event === "coy"
  ) {
    return event;
  }
  if (event === "breath" || event === "pant") return "moan";
  return null;
}

export function toggleEventChip(events: readonly TagEvent[], chip: EventChip): TagEvent[] {
  if (chip === "none") return [];
  if (events.includes(chip)) return uniqueEvents(events.filter((event) => event !== chip));
  return uniqueEvents([...events, chip]);
}

export function parseAcousticTags(value: unknown): AcousticTags | null {
  const parsed = parsePartialAcousticTags(value);
  if (!parsed) return null;
  if (parsed.length == null && parsed.contour == null && parsed.voice == null && parsed.events == null) return null;
  return parsed;
}

export function parsePartialAcousticTags(value: unknown): Partial<AcousticTags> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const out: Partial<AcousticTags> = {};
  if (isTagLength(row.length)) out.length = row.length;
  if (isTagContour(row.contour)) out.contour = row.contour;
  const voice = row.voice === "whisper" ? "breathy" : row.voice;
  if (isTagVoice(voice)) out.voice = voice;
  if ("events" in row || "event" in row) out.events = normalizeEvents(row.events ?? row.event);
  return out;
}

export function parseTagKeys(value: unknown): TagKey[] {
  if (!Array.isArray(value)) return [];
  const keys: TagKey[] = [];
  for (const item of value) {
    if (item === "event" || item === "events") {
      if (!keys.includes("events")) keys.push("events");
      continue;
    }
    if (TAG_KEYS.includes(item as TagKey) && !keys.includes(item as TagKey)) keys.push(item as TagKey);
  }
  return keys;
}

export function tagsTouched(predicted: AcousticTags, chosen: AcousticTags): TagKey[] {
  const keys: TagKey[] = [];
  if (predicted.length !== chosen.length) keys.push("length");
  if (predicted.contour !== chosen.contour) keys.push("contour");
  if (predicted.voice !== chosen.voice) keys.push("voice");
  if (!eventsEqual(predicted.events, chosen.events)) keys.push("events");
  return keys;
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
      case "events":
        gold.events = chosen.events;
        break;
    }
  }
  return gold;
}

export function formatAcousticTag(tags: AcousticTags): string {
  const length = tags.length ?? "";
  const contour = tags.contour ?? "";
  const voice = tags.voice ?? "";
  const right = tags.events ? uniqueEvents(tags.events).join("+") : "";
  if (!length && !contour && !voice && !right) return "";
  return `〔${length}·${contour}·${voice}｜${right}〕`;
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
  const tags: AcousticTags = {};
  if (!cues.length) return tags;
  if (cues.some((cue) => cue.length === "long")) tags.length = "long";
  else if (cues.some((cue) => cue.length === "short")) tags.length = "short";

  const contours = cues.map((cue) => cue.contour).filter(isTagContour);
  const unique = new Set(contours);
  if (unique.size >= 3) tags.contour = "wavering";
  else if (unique.size === 2) tags.contour = unique.has("wavering") ? "wavering" : contours[contours.length - 1]!;
  else if (contours[0]) tags.contour = contours[0];

  if (cues.some((cue) => cue.voice === "breathy" || cue.voice === "whisper")) tags.voice = "breathy";
  else if (cues.some((cue) => cue.voice === "normal")) tags.voice = "normal";

  const events = uniqueEvents(cues.map((cue) => cueEventToTag(cue.event)));
  tags.events = events;
  return tags;
}

export function withMeowFromText(tags: AcousticTags, text: string): AcousticTags {
  if (!/喵|嗷呜/.test(text)) return tags;
  return { ...tags, events: uniqueEvents([...(tags.events ?? []), "meow"]) };
}

export function lengthOnlyTags(tags: AcousticTags | null | undefined): AcousticTags {
  return tags?.length ? { length: tags.length } : {};
}

export function predictUtteranceTags(input: {
  cues?: Array<{ length?: string; contour?: string; voice?: string; event?: string | null }>;
  frames?: ProsodyFrame[];
}): AcousticTags {
  if (input.cues?.length) return tagsFromCues(input.cues);
  if (input.frames?.length) return tagsFromProsody(input.frames);
  return {};
}

export function tagsFromProsody(frames: ProsodyFrame[]): AcousticTags {
  const tags: AcousticTags = {};
  if (!frames.length) return tags;
  const islands = voicedIslands(frames);
  const dur =
    islands.length > 0
      ? islands.reduce((sum, island) => sum + Math.max(0, island.end - island.start), 0)
      : Math.max(0, (frames.at(-1)?.t ?? 0) - (frames[0]?.t ?? 0));
  tags.length = dur >= 0.42 ? "long" : "short";
  return tags;
}

export type EventPr = { precision: number | null; recall: number | null };

export type TagAccuracy = {
  length: number | null;
  contour: number | null;
  voice: number | null;
  events: Record<TagEvent, EventPr>;
};

export function emptyEventScores(): Record<TagEvent, EventPr> {
  return {
    laugh: { precision: null, recall: null },
    cry: { precision: null, recall: null },
    sigh: { precision: null, recall: null },
    moan: { precision: null, recall: null },
    meow: { precision: null, recall: null },
    coy: { precision: null, recall: null },
  };
}

export function scoreTagAccuracy(
  clips: Array<{
    predictedTags?: AcousticTags | null;
    goldTags?: Partial<AcousticTags> | null;
    tagsTouched?: TagKey[] | null;
  }>,
): TagAccuracy {
  const out: TagAccuracy = {
    length: null,
    contour: null,
    voice: null,
    events: emptyEventScores(),
  };
  for (const key of ["length", "contour", "voice"] as const) {
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

  const eventClips = clips.filter((clip) => clip.tagsTouched?.includes("events"));
  if (!eventClips.length) return out;
  for (const event of TAG_EVENT_VALUES) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const clip of eventClips) {
      const gold = eventsOf(clip.goldTags);
      const predicted = eventsOf(clip.predictedTags);
      const goldHas = gold.includes(event);
      const predHas = predicted.includes(event);
      if (goldHas && predHas) tp += 1;
      else if (predHas && !goldHas) fp += 1;
      else if (goldHas && !predHas) fn += 1;
    }
    out.events[event] = {
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: tp + fn ? tp / (tp + fn) : null,
    };
  }
  return out;
}

function eventsOf(tags: { events?: unknown; event?: unknown } | null | undefined): TagEvent[] {
  if (!tags) return [];
  return normalizeEvents(tags.events ?? tags.event);
}

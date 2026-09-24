export const DROP_PORTRAIT_TOPICS = [
  "整夜陪伴承诺",
  "整夜陪伴",
  "噩梦安抚",
  "任务激励与主导",
  "林泽前的占有展示",
] as const;

/** Exact rows from seed/story.json. Do not add lookalikes. */
export const SEED_PORTRAIT_IDS = [
  "p:qingran",
  "p:rosie",
  "p:linze",
  "p:world",
  "p:cycle",
  "p:system",
  "p:bond",
  "p:home",
  "p:stance",
  "p:names",
] as const;

export const SEED_PORTRAIT_TOPICS = [
  "清然",
  "Rosie",
  "林泽",
  "世界观",
  "周期",
  "匹配系统",
  "关系",
  "住所",
  "相处方式",
  "称呼",
] as const;

const SEED_IDS = new Set<string>(SEED_PORTRAIT_IDS);
const SEED_TOPICS = new Set<string>(SEED_PORTRAIT_TOPICS);
const DROP_TOPICS = new Set<string>(DROP_PORTRAIT_TOPICS);

export const EVENT_TEXT_RE = /承诺|安抚|占有展示|今晚|这一次|那天|噩梦/;

export type StoredPortraitKind = "trait" | "episode" | "seed";

export function isStorySeedPortrait(row: { id?: string; topic?: string; kind?: string }): boolean {
  if (row.kind === "seed") return true;
  if (row.id && SEED_IDS.has(row.id)) return true;
  if (row.topic && SEED_TOPICS.has(row.topic)) return true;
  return false;
}

export function portraitKindOf(row: { id?: string; topic?: string; kind?: string }): StoredPortraitKind {
  if (isStorySeedPortrait(row)) return "seed";
  if (row.kind === "episode") return "episode";
  return "trait";
}

/** Confirmed event cleanup only. Thin evidence is not an event. */
export function isConfirmedEventPortrait(row: { id?: string; topic?: string; body?: string; kind?: string }): boolean {
  if (isStorySeedPortrait(row)) return false;
  const topic = row.topic ?? "";
  if (DROP_TOPICS.has(topic)) return true;
  if (row.kind === "episode") return true;
  return EVENT_TEXT_RE.test(`${topic}${row.body ?? ""}`);
}

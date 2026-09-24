import { cer, textsExact, toneMarksMatch } from "./metrics.ts";
import { emptyEngineUse, type EngineUseStats } from "./select.ts";
import { scoreTagAccuracy, type AcousticTags, type TagAccuracy, type TagKey } from "./tags.ts";

export type ScoreWindow = "7d" | "all";

export type ScoreClip = {
  id: string;
  createdAt: string;
  finalText: string;
  xaiText: string;
  liveText: string;
  goldText: string;
  goldSource?: string | null;
  noiseOnly: boolean;
  utteranceEmotion: string | null;
  literalMismatch?: boolean;
  toneNote?: string | null;
  turnId: string | null;
  predictedTags?: AcousticTags | null;
  goldTags?: Partial<AcousticTags> | null;
  tagsTouched?: TagKey[] | null;
  vadFloor?: number | null;
};

export type WorstClip = {
  id: string;
  turnId: string | null;
  hyp: string;
  gold: string;
  emotion: string | null;
  literalMismatch: boolean;
  toneNote: string | null;
  cer: number;
  noiseOnly: boolean;
  predictedTags?: AcousticTags | null;
  goldTags?: Partial<AcousticTags> | null;
  tagsTouched?: TagKey[] | null;
  vadFloor?: number | null;
};

export type HearingScore = {
  clipN: number;
  goldN: number;
  cerFinal: number | null;
  cerXai: number | null;
  cerLive: number | null;
  liveEmptyRate: number;
  liveHasData: boolean;
  exactMatch: number | null;
  toneAccuracy: number | null;
  tagAccuracy: TagAccuracy;
  noiseN: number;
  noiseRecognizedRate: number | null;
  hallucinationN: number;
  hallucinationByReason: { apple_empty: number; short_quiet: number };
  engineUse: EngineUseStats;
  worst: WorstClip[];
  /** Oldest → newest, so a climbing floor reads left to right. */
  recentFloors: Array<{ id: string; createdAt: string; vadFloor: number }>;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function inScoreWindow(createdAt: string, window: ScoreWindow, now = Date.now()): boolean {
  if (window === "all") return true;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return true;
  return now - t <= WEEK_MS;
}

export function scoreHearing(
  clips: ScoreClip[],
  input: {
    window?: ScoreWindow;
    hallucinationN?: number;
    hallucinationByReason?: { apple_empty?: number; short_quiet?: number };
    engineUse?: EngineUseStats;
    now?: number;
  } = {},
): HearingScore {
  const window = input.window ?? "all";
  const now = input.now ?? Date.now();
  const rows = clips.filter((clip) => inScoreWindow(clip.createdAt, window, now));
  const golded = rows.filter(isGoldLabeled);
  const liveGolded = golded.filter((clip) => clip.liveText.trim().length > 0);
  const liveEmptyRate = golded.length
    ? golded.filter((clip) => !clip.liveText.trim()).length / golded.length
    : rows.length
      ? rows.filter((clip) => !clip.liveText.trim()).length / rows.length
      : 1;
  const noise = rows.filter((clip) => clip.noiseOnly);
  const recognized = (clip: ScoreClip) =>
    Boolean((clip.finalText || clip.xaiText || clip.liveText).trim());
  const worst = golded
    .map((clip) => ({
      id: clip.id,
      turnId: clip.turnId,
      hyp: clip.finalText,
      gold: clip.goldText,
      emotion: clip.utteranceEmotion,
      literalMismatch: Boolean(clip.literalMismatch),
      toneNote: clip.toneNote ?? null,
      cer: cer(clip.goldText, clip.finalText),
      noiseOnly: clip.noiseOnly,
      predictedTags: clip.predictedTags,
      goldTags: clip.goldTags,
      tagsTouched: clip.tagsTouched,
      vadFloor: clip.vadFloor ?? null,
    }))
    .sort((a, b) => b.cer - a.cer || a.id.localeCompare(b.id))
    .slice(0, 20);
  const recentFloors = rows
    .filter((clip) => typeof clip.vadFloor === "number" && Number.isFinite(clip.vadFloor))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(-12)
    .map((clip) => ({ id: clip.id, createdAt: clip.createdAt, vadFloor: clip.vadFloor as number }));

  return {
    clipN: rows.length,
    goldN: golded.length,
    cerFinal: mean(golded.map((clip) => cer(clip.goldText, clip.finalText))),
    cerXai: mean(golded.map((clip) => cer(clip.goldText, clip.xaiText))),
    cerLive: mean(liveGolded.map((clip) => cer(clip.goldText, clip.liveText))),
    liveEmptyRate,
    liveHasData: liveGolded.length > 0,
    exactMatch: golded.length
      ? golded.filter((clip) => textsExact(clip.goldText, clip.finalText)).length / golded.length
      : null,
    toneAccuracy: golded.length
      ? golded.filter((clip) => toneMarksMatch(clip.goldText, clip.finalText)).length / golded.length
      : null,
    tagAccuracy: scoreTagAccuracy(golded),
    noiseN: noise.length,
    noiseRecognizedRate: noise.length ? noise.filter(recognized).length / noise.length : null,
    hallucinationN: input.hallucinationN ?? 0,
    hallucinationByReason: {
      apple_empty: input.hallucinationByReason?.apple_empty ?? 0,
      short_quiet: input.hallucinationByReason?.short_quiet ?? 0,
    },
    engineUse: input.engineUse ?? emptyEngineUse(),
    worst,
    recentFloors,
  };
}

function isGoldLabeled(clip: ScoreClip): boolean {
  if (clip.goldSource) return true;
  return clip.goldText.trim().length > 0;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

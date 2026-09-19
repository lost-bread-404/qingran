import { cer, hasCueToneMarks, textsExact, toneMarksMatch } from "./metrics.ts";

export type ScoreWindow = "7d" | "all";

export type ScoreClip = {
  id: string;
  createdAt: string;
  finalText: string;
  xaiText: string;
  liveText: string;
  goldText: string;
  noiseOnly: boolean;
  utteranceEmotion: string | null;
  literalMismatch?: boolean;
  toneNote?: string | null;
  turnId: string | null;
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
  noiseN: number;
  noiseRecognizedRate: number | null;
  hallucinationN: number;
  worst: WorstClip[];
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
  input: { window?: ScoreWindow; hallucinationN?: number; now?: number } = {},
): HearingScore {
  const window = input.window ?? "all";
  const now = input.now ?? Date.now();
  const rows = clips.filter((clip) => inScoreWindow(clip.createdAt, window, now));
  const golded = rows.filter((clip) => clip.goldText.trim().length > 0);
  const liveGolded = golded.filter((clip) => clip.liveText.trim().length > 0);
  const liveEmptyRate = golded.length
    ? golded.filter((clip) => !clip.liveText.trim()).length / golded.length
    : rows.length
      ? rows.filter((clip) => !clip.liveText.trim()).length / rows.length
      : 1;
  const noise = rows.filter((clip) => clip.noiseOnly);
  const recognized = (clip: ScoreClip) =>
    Boolean((clip.finalText || clip.xaiText || clip.liveText).trim());
  const withTone = golded.filter((clip) => hasCueToneMarks(clip.goldText));
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
    }))
    .sort((a, b) => b.cer - a.cer || a.id.localeCompare(b.id))
    .slice(0, 20);

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
    toneAccuracy: withTone.length
      ? withTone.filter((clip) => toneMarksMatch(clip.goldText, clip.finalText)).length / withTone.length
      : null,
    noiseN: noise.length,
    noiseRecognizedRate: noise.length ? noise.filter(recognized).length / noise.length : null,
    hallucinationN: input.hallucinationN ?? 0,
    worst,
  };
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

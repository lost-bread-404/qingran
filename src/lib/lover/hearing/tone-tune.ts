import { cueToneMarks, hasCueToneMarks, toneMarksMatch } from "./metrics.ts";
import { recoverCues } from "../stt-text.ts";
import {
  DEFAULT_TONE_THRESHOLDS,
  framesFromStored,
  parseStoredProsody,
  type StoredProsody,
  type ToneThresholds,
} from "../prosody.ts";

export type ToneTuneClip = {
  id: string;
  goldText: string;
  hypText?: string;
  prosody?: StoredProsody | null;
};

export type ToneTuneScore = {
  n: number;
  withGoldMarks: number;
  accuracy: number;
  exact: number;
};

export type ToneTuneResult = {
  best: ToneThresholds;
  bestScore: ToneTuneScore;
  defaultScore: ToneTuneScore;
  grid: Array<{ thresholds: ToneThresholds; score: ToneTuneScore }>;
};

const GRID: Array<Partial<ToneThresholds>> = [
  {},
  { riseQuestion: 1.12, glideRatio: 0.045 },
  { riseQuestion: 1.15, glideRatio: 0.05 },
  { riseQuestion: 1.18, glideRatio: 0.055 },
  { riseQuestion: 1.22, glideRatio: 0.06 },
  { fadeRatio: 0.65, longDur: 0.36 },
  { fadeRatio: 0.72, longDur: 0.42 },
  { fadeRatio: 0.78, longDur: 0.48 },
  { waveDur: 0.12, bangDur: 0.2 },
  { waveDur: 0.16, bangDur: 0.24 },
  { waveDur: 0.2, bangDur: 0.28 },
];

export function scoreToneMarks(
  clips: ToneTuneClip[],
  th: ToneThresholds = DEFAULT_TONE_THRESHOLDS,
): ToneTuneScore {
  let n = 0;
  let withGoldMarks = 0;
  let exact = 0;
  for (const clip of clips) {
    const frames = framesFromStored(clip.prosody ?? null);
    if (!frames.length) continue;
    n += 1;
    const generated = recoverCues(clip.hypText ?? "", frames, th);
    if (hasCueToneMarks(clip.goldText)) withGoldMarks += 1;
    if (toneMarksMatch(clip.goldText, generated)) exact += 1;
  }
  return {
    n,
    withGoldMarks,
    accuracy: n ? exact / n : 0,
    exact,
  };
}

export function tuneToneThresholds(clips: ToneTuneClip[]): ToneTuneResult {
  const usable = clips.filter((clip) => framesFromStored(clip.prosody ?? null).length);
  const defaultScore = scoreToneMarks(usable, DEFAULT_TONE_THRESHOLDS);
  const grid: ToneTuneResult["grid"] = [];
  let best = DEFAULT_TONE_THRESHOLDS;
  let bestScore = defaultScore;
  for (const patch of GRID) {
    const thresholds = { ...DEFAULT_TONE_THRESHOLDS, ...patch };
    const score = scoreToneMarks(usable, thresholds);
    grid.push({ thresholds, score });
    if (score.accuracy > bestScore.accuracy || (score.accuracy === bestScore.accuracy && score.exact > bestScore.exact)) {
      best = thresholds;
      bestScore = score;
    }
  }
  return { best, bestScore, defaultScore, grid };
}

export function parseTuneClips(
  rows: Array<{ id: string; gold_text?: string | null; final_text?: string | null; xai_text?: string | null; prosody?: unknown }>,
): ToneTuneClip[] {
  return rows.map((row) => ({
    id: row.id,
    goldText: row.gold_text ?? "",
    hypText: row.xai_text ?? row.final_text ?? "",
    prosody: parseStoredProsody(row.prosody),
  }));
}

export { cueToneMarks, hasCueToneMarks, toneMarksMatch };

import {
  CLUE_MAX_P,
  FINDING_MAX_P,
  FINDING_MIN_EXPOSED,
  FINDING_MIN_LIFT,
  FINDING_MIN_N11,
  FINDING_MIN_UNEXPOSED,
  LAG_MAX,
  RECOVERY_MAX_P,
  STALL_DAYS,
  STUCK_MIN_WEEKS,
} from "../config.ts";
import { now } from "../clock.ts";
import { daysInclusive, isoWeek, shiftDay } from "../time.ts";
import type { DayFactor, DayLog, Episode, Finding, Intention, Theme } from "../types.ts";

export type FactorValue = 1 | 0 | null;

export type Series = Record<string, FactorValue>;

function hashFinding(kind: string, outcome: string, antecedent: string, lag: number): string {
  return `${kind}:${outcome}:${antecedent}:${lag}`;
}

export function windowValue(series: Series, day: string, k: number): FactorValue {
  if (k <= 0) return series[day] ?? null;
  const days = daysInclusive(shiftDay(day, -k), shiftDay(day, -1));
  let saw1 = false;
  let allKnownZero = true;
  for (const d of days) {
    const v = series[d];
    if (v === 1) saw1 = true;
    if (v !== 0) allKnownZero = false;
  }
  if (saw1) return 1;
  if (allKnownZero && days.length > 0) return 0;
  return null;
}

export type LiftCounts = { n11: number; n10: number; n01: number; n00: number };

export function addCell(counts: LiftCounts, o: FactorValue, x: FactorValue) {
  if (o == null || x == null) return;
  if (o === 1 && x === 1) counts.n11 += 1;
  else if (o === 0 && x === 1) counts.n10 += 1;
  else if (o === 1 && x === 0) counts.n01 += 1;
  else counts.n00 += 1;
}

export function liftOf(c: LiftCounts): number {
  const p1 = (c.n11 + 1) / (c.n11 + c.n10 + 2);
  const p0 = (c.n01 + 1) / (c.n01 + c.n00 + 2);
  if (p0 === 0) return Infinity;
  return p1 / p0;
}

export function scoreOf(c: LiftCounts, lift: number): number {
  if (lift <= 0) return 0;
  return c.n11 * Math.log(lift);
}

export function keepFinding(c: LiftCounts, lift: number, maxP = FINDING_MAX_P): boolean {
  return classifyFinding(c, lift, maxP) != null;
}

function meetsBase(c: LiftCounts, lift: number): boolean {
  return (
    c.n11 >= FINDING_MIN_N11 &&
    c.n11 + c.n10 >= FINDING_MIN_EXPOSED &&
    c.n01 + c.n00 >= FINDING_MIN_UNEXPOSED &&
    lift >= FINDING_MIN_LIFT
  );
}

/** p≤FINDING_MAX_P → finding；FINDING_MAX_P < p ≤ maxP → clue。maxP 默认 CLUE_MAX_P。 */
export function classifyFinding(
  c: LiftCounts,
  lift: number,
  maxP = CLUE_MAX_P,
): Finding["tier"] | null {
  if (!meetsBase(c, lift)) return null;
  const p = fisherOneSided(c);
  if (p <= FINDING_MAX_P) return "finding";
  if (p <= maxP) return "clue";
  return null;
}

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/**
 * 单侧 Fisher exact test：在边际固定时，n11 至少这么大的概率。
 * 用来过滤小样本和“对照组几乎为空”造成的虚高 lift。
 */
export function fisherOneSided(c: LiftCounts): number {
  const row1 = c.n11 + c.n10;
  const col1 = c.n11 + c.n01;
  const n = c.n11 + c.n10 + c.n01 + c.n00;
  const maxA = Math.min(row1, col1);
  const base =
    logFactorial(row1) + logFactorial(n - row1) + logFactorial(col1) + logFactorial(n - col1) - logFactorial(n);
  let p = 0;
  for (let a = c.n11; a <= maxA; a++) {
    const b = row1 - a;
    const cc = col1 - a;
    const d = n - row1 - cc;
    if (b < 0 || cc < 0 || d < 0) continue;
    p += Math.exp(base - logFactorial(a) - logFactorial(b) - logFactorial(cc) - logFactorial(d));
  }
  return Math.min(1, p);
}

export function buildEpisodes(
  factorId: string,
  series: Series,
  orderedDays: string[],
  at = now(),
): Episode[] {
  const episodes: Episode[] = [];
  let i = 0;
  while (i < orderedDays.length) {
    if (series[orderedDays[i]!] !== 1) {
      i += 1;
      continue;
    }
    const start = i;
    let end = i;
    i += 1;
    while (i < orderedDays.length) {
      const v = series[orderedDays[i]!];
      if (v === 1) {
        end = i;
        i += 1;
        continue;
      }
      if (v == null && i + 1 < orderedDays.length && series[orderedDays[i + 1]!] === 1) {
        i += 1;
        continue;
      }
      break;
    }
    const startDay = orderedDays[start]!;
    const endDay = orderedDays[end]!;
    const after = orderedDays[end + 1];
    const endKnown = after != null ? series[after] !== null && series[after] !== undefined : false;
    const days = daysInclusive(startDay, endDay).length;
    episodes.push({
      id: `ep:${factorId}:${startDay}`,
      factorId,
      startDay,
      endDay,
      endKnown,
      days,
      evidenceIds: [],
      computedAt: at,
    });
  }
  return episodes;
}

function collectDays(
  outcome: Series,
  antecedent: Series,
  orderedDays: string[],
  k: number,
  wantO: 1 | 0,
  wantX: 1 | 0,
  limit = 5,
): string[] {
  const out: string[] = [];
  for (const d of orderedDays) {
    const o = outcome[d] ?? null;
    const x = windowValue(antecedent, d, k);
    if (o === wantO && x === wantX) {
      out.push(d);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function lagAnalysis(
  outcomeId: string,
  antecedentId: string,
  outcome: Series,
  antecedent: Series,
  orderedDays: string[],
  at = now(),
): Finding | null {
  let best: { lag: number; counts: LiftCounts; lift: number; score: number; tier: Finding["tier"] } | null = null;
  for (let k = 0; k <= LAG_MAX; k++) {
    const counts: LiftCounts = { n11: 0, n10: 0, n01: 0, n00: 0 };
    for (const d of orderedDays) {
      const o = outcome[d] ?? null;
      if (o == null) continue;
      // 只看“可能开始”的天：前一天状态已知且为 0。
      // 连续多天的状态只算一次起点，避免自相关把显著性虚高。
      if ((outcome[shiftDay(d, -1)] ?? null) !== 0) continue;
      const x = windowValue(antecedent, d, k);
      addCell(counts, o, x);
    }
    const lift = liftOf(counts);
    const tier = classifyFinding(counts, lift);
    if (!tier) continue;
    const score = scoreOf(counts, lift);
    if (!best || score > best.score) best = { lag: k, counts, lift, score, tier };
  }
  if (!best) return null;
  return {
    id: hashFinding("antecedent", outcomeId, antecedentId, best.lag),
    kind: "antecedent",
    outcomeId,
    antecedentId,
    lag: best.lag,
    ...best.counts,
    lift: best.lift,
    score: best.score,
    exampleDays: collectDays(outcome, antecedent, orderedDays, best.lag, 1, 1),
    counterDays: collectDays(outcome, antecedent, orderedDays, best.lag, 0, 1),
    userFeedback: null,
    computedAt: at,
    tier: best.tier,
  };
}

export function recoveryAnalysis(
  outcomeId: string,
  antecedentId: string,
  outcome: Series,
  antecedent: Series,
  episodes: Episode[],
  at = now(),
): Finding | null {
  const relevant = episodes.filter((e) => e.factorId === outcomeId);
  let best: { lag: number; counts: LiftCounts; lift: number; score: number } | null = null;
  for (let k = 0; k <= 2; k++) {
    const counts: LiftCounts = { n11: 0, n10: 0, n01: 0, n00: 0 };
    for (const ep of relevant) {
      if (!ep.endDay) continue;
      const days = daysInclusive(ep.startDay, ep.endDay);
      for (const d of days) {
        // endDay 是低谷的最后一天；“在 d+1 或 d+2 走出来”即 endDay ∈ {d, d+1}
        const endsSoon = (ep.endDay === d || shiftDay(d, 1) === ep.endDay) && ep.endKnown;
        const r: FactorValue = endsSoon ? 1 : 0;
        const x = windowValue(antecedent, d, k);
        addCell(counts, r, x);
      }
    }
    const lift = liftOf(counts);
    // 恢复路径只在低谷期内部计算、样本天然少；达标后一律标 clue
    if (!classifyFinding(counts, lift, RECOVERY_MAX_P)) continue;
    const score = scoreOf(counts, lift);
    if (!best || score > best.score) best = { lag: k, counts, lift, score };
  }
  if (!best) return null;
  return {
    id: hashFinding("recovery", outcomeId, antecedentId, best.lag),
    kind: "recovery",
    outcomeId,
    antecedentId,
    lag: best.lag,
    ...best.counts,
    lift: best.lift,
    score: best.score,
    exampleDays: [],
    counterDays: [],
    userFeedback: null,
    computedAt: at,
    tier: "clue",
  };
}

export function cooccurAnalysis(
  aId: string,
  bId: string,
  aWeeks: Record<string, number>,
  bWeeks: Record<string, number>,
  weeks: string[],
  at = now(),
): Finding | null {
  const counts: LiftCounts = { n11: 0, n10: 0, n01: 0, n00: 0 };
  const example: string[] = [];
  const counter: string[] = [];
  for (const w of weeks) {
    const a = (aWeeks[w] ?? 0) > 0 ? 1 : 0;
    const b = (bWeeks[w] ?? 0) > 0 ? 1 : 0;
    addCell(counts, a, b);
    if (a === 1 && b === 1 && example.length < 5) example.push(w);
    if (a === 0 && b === 1 && counter.length < 5) counter.push(w);
  }
  const lift = liftOf(counts);
  const tier = classifyFinding(counts, lift);
  if (!tier) return null;
  return {
    id: hashFinding("cooccur", aId, bId, 0),
    kind: "cooccur",
    outcomeId: aId,
    antecedentId: bId,
    lag: 0,
    ...counts,
    lift,
    score: scoreOf(counts, lift),
    exampleDays: example,
    counterDays: counter,
    userFeedback: null,
    computedAt: at,
    tier,
  };
}

export type StuckLoop = { themeId: string; weeks: number; actionRate: number };

export function stuckLoops(
  weeksByTheme: Record<string, Array<{ week: string; mentions: number; actionTaken: number | null }>>,
  recentWeeks: string[],
): StuckLoop[] {
  const last6 = recentWeeks.slice(-6);
  const out: StuckLoop[] = [];
  for (const [themeId, rows] of Object.entries(weeksByTheme)) {
    const map = new Map(rows.map((r) => [r.week, r]));
    const active = last6.filter((w) => (map.get(w)?.mentions ?? 0) > 0);
    if (active.length < STUCK_MIN_WEEKS) continue;
    const acted = active.filter((w) => map.get(w)?.actionTaken === 1).length;
    const rate = acted / active.length;
    if (rate <= 1 / 3) out.push({ themeId, weeks: active.length, actionRate: rate });
  }
  return out;
}

export type SayDo = {
  tag: string;
  done: number;
  dropped: number;
  stalled: number;
  completion: number;
  startDelayMedian: number | null;
  stalledIds: string[];
};

export function sayDoByTag(intentions: Intention[], at = now()): SayDo[] {
  const groups = new Map<string, Intention[]>();
  for (const it of intentions) {
    const tag = it.tag || "未分类";
    const list = groups.get(tag) ?? [];
    list.push(it);
    groups.set(tag, list);
  }
  const out: SayDo[] = [];
  for (const [tag, list] of groups) {
    let done = 0;
    let dropped = 0;
    let stalled = 0;
    const delays: number[] = [];
    const stalledIds: string[] = [];
    for (const it of list) {
      const ageDays = (at - it.lastEvidenceAt) / 86_400_000;
      const isStalled =
        (it.status === "open" || it.status === "started") && ageDays > STALL_DAYS;
      if (it.status === "done") done += 1;
      else if (it.status === "dropped") dropped += 1;
      if (isStalled) {
        stalled += 1;
        stalledIds.push(it.id);
      }
      if (it.status === "done" || it.status === "started") {
        const start = it.startedAt ?? it.doneAt;
        if (start) delays.push(start - it.statedAt);
      }
    }
    delays.sort((a, b) => a - b);
    const denom = done + dropped + stalled;
    const median =
      delays.length === 0
        ? null
        : delays.length % 2
          ? delays[(delays.length - 1) / 2]!
          : (delays[delays.length / 2 - 1]! + delays[delays.length / 2]!) / 2;
    out.push({
      tag,
      done,
      dropped,
      stalled,
      completion: denom === 0 ? 0 : done / denom,
      startDelayMedian: median,
      stalledIds,
    });
  }
  return out;
}

export type Baseline = {
  energyAvg: number | null;
  moodAvg: number | null;
  okDays: number;
  lastActiveMedian: number | null;
};

export function weeklyBaseline(days: DayLog[]): Baseline {
  const energy = days.map((d) => d.energy).filter((v): v is number => v != null);
  const mood = days.map((d) => d.mood).filter((v): v is number => v != null);
  const okDays = days.filter((d) => d.coverage === "ok").length;
  const last = days
    .map((d) => d.lastActive)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const median =
    last.length === 0
      ? null
      : last.length % 2
        ? last[(last.length - 1) / 2]!
        : (last[last.length / 2 - 1]! + last[last.length / 2]!) / 2;
  return { energyAvg: avg(energy), moodAvg: avg(mood), okDays, lastActiveMedian: median };
}

export function safetyFlag(
  lowMoodEpisodes: Episode[],
  nowDay: string,
): boolean {
  const recentStart = shiftDay(nowDay, -28);
  const prevStart = shiftDay(nowDay, -84);
  const recent = lowMoodEpisodes.filter((e) => e.startDay >= recentStart);
  const prev = lowMoodEpisodes.filter((e) => e.startDay >= prevStart && e.startDay < recentStart);
  const recentDays = recent.reduce((s, e) => s + e.days, 0);
  const prevDays = prev.reduce((s, e) => s + e.days, 0);
  const recentWeekly = recentDays / 4;
  const prevWeekly = prevDays / 8;
  return recentDays >= 7 && prevWeekly > 0 && recentWeekly >= prevWeekly * 1.5;
}

export function seriesFromDayFactors(rows: DayFactor[], factorId: string): Series {
  const s: Series = {};
  for (const r of rows) {
    if (r.factorId === factorId) s[r.day] = r.value;
  }
  return s;
}

export function orderedUnionDays(rows: DayFactor[]): string[] {
  return [...new Set(rows.map((r) => r.day))].sort();
}

export function computeAllFindings(opts: {
  factors: Array<{ id: string; isOutcome: boolean }>;
  dayFactors: DayFactor[];
  themeWeeks: Array<{ themeId: string; week: string; mentions: number }>;
  now?: number;
}): Finding[] {
  const at = opts.now ?? now();
  const days = orderedUnionDays(opts.dayFactors);
  const outcomes = opts.factors.filter((f) => f.isOutcome);
  const others = opts.factors;
  const findings: Finding[] = [];
  for (const o of outcomes) {
    const oSeries = seriesFromDayFactors(opts.dayFactors, o.id);
    const episodes = buildEpisodes(o.id, oSeries, days, at);
    for (const x of others) {
      if (x.id === o.id) continue;
      const xSeries = seriesFromDayFactors(opts.dayFactors, x.id);
      const lag = lagAnalysis(o.id, x.id, oSeries, xSeries, days, at);
      if (lag) findings.push(lag);
      const rec = recoveryAnalysis(o.id, x.id, oSeries, xSeries, episodes, at);
      if (rec) findings.push(rec);
    }
  }
  const weeks = [...new Set(opts.themeWeeks.map((t) => t.week))].sort();
  const byTheme: Record<string, Record<string, number>> = {};
  for (const row of opts.themeWeeks) {
    byTheme[row.themeId] ??= {};
    byTheme[row.themeId]![row.week] = row.mentions;
  }
  const themeIds = Object.keys(byTheme);
  for (let i = 0; i < themeIds.length; i++) {
    for (let j = i + 1; j < themeIds.length; j++) {
      const a = themeIds[i]!;
      const b = themeIds[j]!;
      const co = cooccurAnalysis(a, b, byTheme[a]!, byTheme[b]!, weeks, at);
      if (co) findings.push(co);
    }
  }
  return findings;
}

export function recentWeeksFromDays(days: string[], n = 8): string[] {
  const weeks = [...new Set(days.map(isoWeek))].sort();
  return weeks.slice(-n);
}

export { hashFinding };

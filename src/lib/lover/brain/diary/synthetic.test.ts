/**
 * 日记侧合成数据 eval（plan §11 日记侧）：
 * 预埋 3 条规律 + 3 个纯噪声 factor，检查 recall 与 false discovery。
 * 纯代码，不调用模型。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { shiftDay } from "../time.ts";
import type { DayFactor } from "../types.ts";
import { computeAllFindings } from "./stats.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const DAYS = Number(process.env.SYN_DAYS || 180);

function simulate(seed: number, days = DAYS) {
  const r = rng(seed);
  const start = "2026-03-01";
  const v: Record<string, Record<string, 0 | 1>> = {
    overnight: {},
    startHard: {},
    rejected: {},
    lowMood: {},
    exercise: {},
    noiseA: {},
    noiseB: {},
    noiseC: {},
  };
  let lowLeft = 0;
  for (let i = 0; i < days; i++) {
    const d = shiftDay(start, i);
    const prev = shiftDay(start, i - 1);
    const prev2 = shiftDay(start, i - 2);
    v.overnight![d] = r() < 0.3 ? 1 : 0;
    // 规律 1：熬夜后第二天启动困难
    v.startHard![d] = r() < (v.overnight![prev] ? 0.75 : 0.12) ? 1 : 0;
    v.rejected![d] = r() < 0.08 ? 1 : 0;
    // 规律 2：被拒后 1–2 天内开始低落
    if (lowLeft === 0 && (v.rejected![prev] || v.rejected![prev2]) && r() < 0.85)
      lowLeft = 4 + Math.floor(r() * 5);
    if (lowLeft === 0 && r() < 0.03) lowLeft = 4 + Math.floor(r() * 5);
    v.exercise![d] = r() < 0.25 ? 1 : 0;
    // 规律 3：低落期间去运动，之后更快结束
    if (lowLeft > 0 && v.exercise![d]) lowLeft = Math.min(lowLeft, 1 + Math.floor(r() * 2));
    v.lowMood![d] = lowLeft > 0 ? 1 : 0;
    if (lowLeft > 0) lowLeft -= 1;
    v.noiseA![d] = r() < 0.3 ? 1 : 0;
    v.noiseB![d] = r() < 0.2 ? 1 : 0;
    v.noiseC![d] = r() < 0.4 ? 1 : 0;
  }
  const rows: DayFactor[] = [];
  for (const [factorId, series] of Object.entries(v)) {
    for (const [day, value] of Object.entries(series)) {
      // 约 15% 的天数据缺失（她没提）
      rows.push({ day, factorId, version: 1, value: r() < 0.15 ? null : value, evidenceIds: [] });
    }
  }
  return rows;
}

const FACTORS = [
  { id: "overnight", isOutcome: false },
  { id: "startHard", isOutcome: true },
  { id: "rejected", isOutcome: false },
  { id: "lowMood", isOutcome: true },
  { id: "exercise", isOutcome: false },
  { id: "noiseA", isOutcome: false },
  { id: "noiseB", isOutcome: false },
  { id: "noiseC", isOutcome: false },
];

const PLANTED = [
  { kind: "antecedent", outcomeId: "startHard", antecedentId: "overnight" },
  { kind: "antecedent", outcomeId: "lowMood", antecedentId: "rejected" },
  { kind: "recovery", outcomeId: "lowMood", antecedentId: "exercise" },
];

test("synthetic diary: planted patterns are recovered, noise rarely surfaces", () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  let hits = 0;
  let total = 0;
  let noise = 0;
  let found = 0;
  const perType: Record<string, number> = {};
  for (const seed of seeds) {
    const findings = computeAllFindings({
      factors: FACTORS,
      dayFactors: simulate(seed),
      themeWeeks: [],
    });
    for (const p of PLANTED) {
      total += 1;
      if (
        findings.some(
          (f) =>
            f.kind === p.kind && f.outcomeId === p.outcomeId && f.antecedentId === p.antecedentId,
        )
      ) {
        hits += 1;
        perType[p.kind] = (perType[p.kind] ?? 0) + 1;
      }
    }
    for (const f of findings) {
      if (f.kind === "cooccur") continue;
      if (f.tier !== "finding") continue;
      found += 1;
      if (f.antecedentId.startsWith("noise")) noise += 1;
    }
  }
  const recall = hits / total;
  const noiseRate = found ? noise / found : 0;
  const antecedentRecall = (perType.antecedent ?? 0) / (seeds.length * 2);
  const recoveryRecall = (perType.recovery ?? 0) / seeds.length;
  if (process.env.DBG)
    for (const seed of seeds) {
      const fs = computeAllFindings({
        factors: FACTORS,
        dayFactors: simulate(seed),
        themeWeeks: [],
      });
      console.log(
        seed,
        fs
          .filter((f) => f.kind !== "cooccur")
          .map(
            (f) =>
              `${f.kind}:${f.antecedentId}->${f.outcomeId} k${f.lag} n11=${f.n11} n10=${f.n10} n01=${f.n01} n00=${f.n00} L${f.lift.toFixed(1)}`,
          )
          .join(" | "),
      );
    }
  console.log(
    `[synthetic] recall=${recall.toFixed(2)} antecedent=${antecedentRecall.toFixed(2)} recovery=${recoveryRecall.toFixed(2)} noise_rate=${noiseRate.toFixed(2)} findings=${found} days=${DAYS} per=${JSON.stringify(perType)}`,
  );
  // 前因规律：约半年数据应能稳定发现；恢复路径样本天然少，只要求多数能发现
  assert.ok(antecedentRecall >= 0.8, `antecedent recall ${antecedentRecall} < 0.8`);
  assert.ok(recoveryRecall >= 0.5, `recovery recall ${recoveryRecall} < 0.5`);
  assert.ok(noiseRate <= 0.2, `noise finding rate ${noiseRate} > 0.2`);
});

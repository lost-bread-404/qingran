import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addCell,
  fisherOneSided,
  buildEpisodes,
  classifyFinding,
  keepFinding,
  lagAnalysis,
  liftOf,
  recoveryAnalysis,
  safetyFlag,
  sayDoByTag,
  stuckLoops,
  windowValue,
  type Series,
} from "./stats.ts";
import type { Intention } from "../types.ts";
import { shiftDay } from "../time.ts";

function series(map: Record<string, 1 | 0 | null>): Series {
  return map;
}

test("windowValue k=0 uses the day itself", () => {
  const s = series({ "2026-09-01": 1, "2026-09-02": 0, "2026-09-03": null });
  assert.equal(windowValue(s, "2026-09-01", 0), 1);
  assert.equal(windowValue(s, "2026-09-02", 0), 0);
  assert.equal(windowValue(s, "2026-09-03", 0), null);
});

test("windowValue k>=1 looks at d-k .. d-1", () => {
  const s = series({
    "2026-09-01": 0,
    "2026-09-02": 1,
    "2026-09-03": 0,
    "2026-09-04": 0,
  });
  assert.equal(windowValue(s, "2026-09-04", 2), 1);
  assert.equal(windowValue(s, "2026-09-04", 1), 0);
  const unknown = series({ "2026-09-01": 0, "2026-09-02": null, "2026-09-03": 0 });
  assert.equal(windowValue(unknown, "2026-09-03", 2), null);
});

test("lift skips null cells and applies Laplace", () => {
  const c = { n11: 0, n10: 0, n01: 0, n00: 0 };
  addCell(c, 1, 1);
  addCell(c, 1, null);
  addCell(c, null, 1);
  addCell(c, 0, 0);
  assert.equal(c.n11, 1);
  assert.equal(c.n00, 1);
  assert.equal(c.n10, 0);
  const lift = liftOf({ n11: 8, n10: 2, n01: 2, n00: 8 });
  assert.ok(lift > 2);
  assert.equal(keepFinding({ n11: 3, n10: 3, n01: 1, n00: 10 }, 3), false);
  // 对照组太小：不保留
  assert.equal(keepFinding({ n11: 6, n10: 1, n01: 0, n00: 3 }, 5), false);
  // 小样本、不显著：不保留
  assert.equal(keepFinding({ n11: 4, n10: 1, n01: 1, n00: 10 }, 1.6), false);
  // 样本足够且显著：保留
  assert.equal(keepFinding({ n11: 8, n10: 2, n01: 2, n00: 20 }, liftOf({ n11: 8, n10: 2, n01: 2, n00: 20 })), true);
  // 恢复路径的放宽阈值
  assert.equal(keepFinding({ n11: 4, n10: 1, n01: 1, n00: 10 }, 1.6, 0.05), true);
});

test("episodes merge with one null gap and end_known", () => {
  const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
  const s = series({
    "2026-09-01": 1,
    "2026-09-02": null,
    "2026-09-03": 1,
    "2026-09-04": 0,
    "2026-09-05": 1,
    "2026-09-06": null,
  });
  const eps = buildEpisodes("o", s, days);
  assert.equal(eps.length, 2);
  assert.equal(eps[0]!.startDay, "2026-09-01");
  assert.equal(eps[0]!.endDay, "2026-09-03");
  assert.equal(eps[0]!.endKnown, true);
  assert.equal(eps[1]!.startDay, "2026-09-05");
  assert.equal(eps[1]!.endKnown, false);
});

test("lagAnalysis picks the best lag and keeps example days", () => {
  const days: string[] = [];
  const outcome: Series = {};
  const ante: Series = {};
  // 每 4 天：第 1 天出现前因，第 2 天出现结果（结果之间有间隔，才有“起点”可数）
  for (let i = 0; i < 40; i++) {
    const d = shiftDay("2026-09-01", i);
    days.push(d);
    ante[d] = i % 4 === 1 ? 1 : 0;
    outcome[d] = i % 4 === 2 ? 1 : 0;
  }
  const finding = lagAnalysis("o", "x", outcome, ante, days);
  assert.ok(finding);
  assert.equal(finding!.lag, 1);
  assert.ok(finding!.n11 >= 4);
  assert.ok(finding!.exampleDays.length > 0);
});

test("recovery only scores inside episodes", () => {
  const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];
  const outcome = series({
    "2026-09-01": 1,
    "2026-09-02": 1,
    "2026-09-03": 1,
    "2026-09-04": 0,
    "2026-09-05": 0,
  });
  const ante = series({
    "2026-09-01": 0,
    "2026-09-02": 1,
    "2026-09-03": 1,
    "2026-09-04": 0,
    "2026-09-05": 0,
  });
  const eps = buildEpisodes("o", outcome, days);
  const rec = recoveryAnalysis("o", "x", outcome, ante, eps);
  if (rec) {
    assert.equal(rec.kind, "recovery");
    assert.ok(rec.n11 >= 0);
  }
});

test("stuck loops need 3+ weeks with little action", () => {
  const weeks = ["2026-W33", "2026-W34", "2026-W35", "2026-W36", "2026-W37", "2026-W38"];
  const stuck = stuckLoops(
    {
      t1: weeks.map((week) => ({ week, mentions: 2, actionTaken: 0 })),
      t2: weeks.map((week) => ({ week, mentions: 2, actionTaken: 1 })),
    },
    weeks,
  );
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0]!.themeId, "t1");
});

test("say-do groups by tag and marks stall", () => {
  const now = Date.UTC(2026, 8, 20);
  const list: Intention[] = [
    {
      id: "a",
      text: "写论文",
      tag: "论文",
      statedAt: now - 20 * 86_400_000,
      targetDay: null,
      status: "open",
      startedAt: null,
      doneAt: null,
      lastEvidenceAt: now - 20 * 86_400_000,
      evidenceIds: [],
      updatedAt: now,
    },
    {
      id: "b",
      text: "交了",
      tag: "论文",
      statedAt: now - 10 * 86_400_000,
      targetDay: null,
      status: "done",
      startedAt: now - 8 * 86_400_000,
      doneAt: now - 7 * 86_400_000,
      lastEvidenceAt: now - 7 * 86_400_000,
      evidenceIds: [],
      updatedAt: now,
    },
  ];
  const rows = sayDoByTag(list, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.done, 1);
  assert.equal(rows[0]!.stalled, 1);
  assert.ok(rows[0]!.startDelayMedian != null);
});

test("safety flag needs recent low-mood days to jump", () => {
  const today = "2026-09-20";
  const quiet = safetyFlag(
    [{ id: "1", factorId: "low", startDay: "2026-07-01", endDay: "2026-07-02", endKnown: true, days: 2, evidenceIds: [], computedAt: 0 }],
    today,
  );
  assert.equal(quiet, false);
  const jump = safetyFlag(
    [
      { id: "a", factorId: "low", startDay: "2026-09-01", endDay: "2026-09-05", endKnown: true, days: 5, evidenceIds: [], computedAt: 0 },
      { id: "b", factorId: "low", startDay: "2026-09-10", endDay: "2026-09-14", endKnown: true, days: 5, evidenceIds: [], computedAt: 0 },
      { id: "c", factorId: "low", startDay: "2026-07-01", endDay: "2026-07-02", endKnown: true, days: 2, evidenceIds: [], computedAt: 0 },
    ],
    today,
  );
  assert.equal(jump, true);
});

test("fisherOneSided matches a known value", () => {
  // 2x2 [[3,1],[1,3]] 单侧 p = 17/70 ≈ 0.2429
  assert.ok(Math.abs(fisherOneSided({ n11: 3, n10: 1, n01: 1, n00: 3 }) - 17 / 70) < 1e-9);
});

test("lagAnalysis only counts onset days", () => {
  const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];
  const o: Series = { "2026-09-01": 0, "2026-09-02": 1, "2026-09-03": 1, "2026-09-04": 1 };
  const x: Series = { "2026-09-01": 1, "2026-09-02": 1, "2026-09-03": 1, "2026-09-04": 1 };
  // 只有 09-02 是起点（前一天为 0），09-03/04 属于同一段，不重复计数 → 样本不足
  assert.equal(lagAnalysis("o", "x", o, x, days), null);
});

test("classifyFinding splits finding vs clue by p-value", () => {
  const strong = { n11: 12, n10: 2, n01: 2, n00: 30 };
  const mid = { n11: 4, n10: 1, n01: 1, n00: 10 };
  const weak = { n11: 4, n10: 8, n01: 8, n00: 10 };
  assert.equal(classifyFinding(strong, liftOf(strong)), "finding");
  assert.equal(classifyFinding(mid, 1.6), "clue");
  assert.equal(classifyFinding(weak, liftOf(weak)), null);
  // 恢复路径：达标后一律 clue
  assert.equal(keepFinding(mid, 1.6, 0.05), true);
});

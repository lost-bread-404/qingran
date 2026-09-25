import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyGlowDelta,
  busyContextLine,
  busyWord,
  clampInHours,
  decideWake,
  glowNow,
  glowWord,
  periodOnDay,
  periodsOverlap,
  randomWakeProbability,
  silenceFloorMs,
  BASE_RANDOM_PER_HOUR,
} from "./life.ts";

test("busy words and the reflect line stay empty when nothing is known", () => {
  assert.equal(busyWord(0.1), "很闲");
  assert.equal(busyWord(0.5), "正常");
  assert.equal(busyWord(0.7), "忙");
  assert.equal(busyWord(0.9), "非常忙");
  assert.equal(busyContextLine({ label: "", busy: 0.5, reason: "", rhythm: "" }), "");
  assert.match(
    busyContextLine({ label: "科研年起步", busy: 0.9, reason: "第一次独立负责实验", rhythm: "晚上相对自由" }),
    /只用于决定下一次什么时候找她/,
  );
  assert.match(
    busyContextLine({ label: "科研年起步", busy: 0.9, reason: "第一次独立负责实验", rhythm: "" }),
    /非常忙，第一次独立负责实验/,
  );
});

test("glow halves every two days and words hide the ordinary band", () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(glowNow(40, 1_000, 1_000 + 2 * day), 20);
  assert.equal(glowWord(0), null);
  assert.equal(glowWord(-8), "有点低落");
  assert.equal(glowWord(-30), "很受伤");
  assert.equal(glowWord(10), "很开心");
  assert.equal(glowWord(30), "特别兴奋");
  const applied = applyGlowDelta(40, 1_000, 1_000 + 2 * day, 4);
  assert.equal(applied.glow, 24);
  assert.equal(applied.event, true);
  assert.equal(applyGlowDelta(10, 1_000, 2_000, 0).event, false);
  assert.equal(applyGlowDelta(60, 1_000, 1_000, 10).glow, 60);
});

test("reach hours, random wake, and unanswered spacing", () => {
  assert.equal(clampInHours(0.01), 10 / 60);
  assert.equal(clampInHours(80), 72);
  const calm = randomWakeProbability({ glow: 0, busy: 0.5, longings: 0 });
  assert.ok(Math.abs(calm - (1 - Math.exp(-BASE_RANDOM_PER_HOUR * 0.9 / 6))) < 1e-9);
  assert.equal(silenceFloorMs(1), 10 * 60_000);
  assert.equal(silenceFloorMs(2), 20 * 60_000);
  assert.equal(silenceFloorMs(6), 320 * 60_000);
});

test("wake stays quiet unless it is due, and the breaker pushes morning", () => {
  const base = {
    enabled: true,
    chatting: false,
    nextAt: null as number | null,
    now: 1_000,
    roll: 0.99,
    probability: 0.01,
    llmToday: 0,
    sentToday: 0,
    tomorrowMorning: 9_000,
  };
  assert.equal(decideWake(base).action, "return");
  assert.equal(decideWake({ ...base, nextAt: 500 }).action, "call");
  const off = decideWake({ ...base, enabled: false });
  assert.equal(off.action, "return");
  if (off.action === "return") assert.equal(off.reason, "disabled");
  const tripped = decideWake({ ...base, nextAt: 500, llmToday: 48 });
  assert.equal(tripped.action, "return");
  if (tripped.action === "return") assert.equal(tripped.nextAt, 9_000);
});

test("busy periods match a day and reject overlap", () => {
  const rows = [
    { id: "a", fromDay: "2026-09-01", toDay: "2026-09-10", busy: 0.8, label: "开学", reason: "实验" },
    { id: "b", fromDay: "2026-09-11", toDay: "2026-12-01", busy: 0.4, label: "平常", reason: "" },
  ];
  assert.equal(periodOnDay(rows, "2026-09-10")?.id, "a");
  assert.equal(periodOnDay(rows, "2026-08-01"), null);
  assert.equal(periodsOverlap(rows), false);
  assert.equal(periodsOverlap([{ fromDay: "2026-09-01", toDay: "2026-09-11" }, rows[1]!]), true);
});

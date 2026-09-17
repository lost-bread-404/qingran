import assert from "node:assert/strict";
import { test } from "node:test";
import { localDay, zonedParts } from "../time.ts";
import {
  defaultSpendLimits,
  resumeAtMs,
  spendDecision,
  validateSpendLimits,
} from "./policy.ts";

const limits = {
  daySoft: 15,
  dayHard: 30,
  dayBreaker: 50,
  monthSoft: 100,
  monthHard: 150,
  monthBreaker: 200,
};
const tz = "America/New_York";
const noon = new Date("2026-09-16T16:00:00Z").getTime(); // 12:00 EDT

function d(route: string, dayUsd: number, monthUsd: number, ov: { day?: boolean; month?: boolean } = {}) {
  return spendDecision(route, dayUsd, monthUsd, limits, ov, noon, tz);
}

test("priority matrix: soft pauses P3 only", () => {
  assert.equal(d("voice", 15, 0).allow, true);
  assert.equal(d("reflect", 15, 0).allow, true);
  assert.equal(d("archive", 15, 0).allow, true);
  assert.equal(d("dusk", 15, 0).allow, true);
  assert.equal(d("synth", 15, 0).allow, false);
  assert.equal(d("report", 15, 0).allow, false);
  assert.equal(d("judge", 15, 0).level, "soft");
});

test("hard pauses P2 and P3, P0 P1 continue", () => {
  assert.equal(d("voice", 30, 0).allow, true);
  assert.equal(d("tts", 30, 0).allow, true);
  assert.equal(d("stt", 30, 0).allow, true);
  assert.equal(d("reflect", 30, 0).allow, true);
  assert.equal(d("archive", 30, 0).allow, false);
  assert.equal(d("ask", 30, 0).allow, false);
  assert.equal(d("portrait", 30, 0).allow, false);
  assert.equal(d("synth", 30, 0).allow, false);
  assert.equal(d("voice", 30, 0).level, "hard");
});

test("breaker pauses everyone", () => {
  assert.equal(d("voice", 50, 0).allow, false);
  assert.equal(d("reflect", 50, 0).allow, false);
  assert.equal(d("voice", 50, 0).level, "breaker");
  assert.equal(d("voice", 50, 0).scope, "day");
});

test("stricter of day vs month wins", () => {
  const r = d("archive", 0, 150);
  assert.equal(r.allow, false);
  assert.equal(r.level, "hard");
  assert.equal(r.scope, "month");
  const s = d("synth", 16, 0);
  assert.equal(s.scope, "day");
});

test("override lifts breaker to hard", () => {
  const r = d("voice", 60, 0, { day: true });
  assert.equal(r.allow, true);
  assert.equal(r.level, "hard");
  assert.equal(d("archive", 60, 0, { day: true }).allow, false);
  assert.equal(d("synth", 60, 0, { day: true }).allow, false);
});

test("resumeAt is next local day 04:30 or next month 1st 04:30", () => {
  const dayResume = resumeAtMs("day", noon, tz);
  const p = zonedParts(dayResume, tz);
  assert.equal(localDay(dayResume, tz), "2026-09-17");
  assert.equal(p.hour, 4);
  assert.equal(p.minute, 30);
  const monthResume = resumeAtMs("month", noon, tz);
  const mp = zonedParts(monthResume, tz);
  assert.equal(mp.year, 2026);
  assert.equal(mp.month, 10);
  assert.equal(mp.day, 1);
  assert.equal(mp.hour, 4);
  assert.equal(mp.minute, 30);
});

test("validateSpendLimits enforces order", () => {
  assert.equal(validateSpendLimits(limits), null);
  assert.ok(validateSpendLimits({ ...limits, dayHard: 10 }));
  assert.ok(validateSpendLimits({ ...limits, monthBreaker: 1 }));
  const dflt = defaultSpendLimits();
  assert.equal(validateSpendLimits(dflt), null);
});

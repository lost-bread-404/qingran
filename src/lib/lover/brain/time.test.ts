import assert from "node:assert/strict";
import { test } from "node:test";
import {
  currentIsoWeek,
  isoWeek,
  isoWeekStart,
  localDay,
  localHour,
  overnightValue,
  previousMonth,
  shiftDay,
  yearMonth,
} from "./time.ts";

test("04:00 is the local day boundary", () => {
  const tz = "UTC";
  assert.equal(localDay(Date.UTC(2026, 8, 16, 3, 59), tz), "2026-09-15");
  assert.equal(localDay(Date.UTC(2026, 8, 16, 4, 0), tz), "2026-09-16");
  assert.equal(localHour(Date.UTC(2026, 8, 16, 2, 30), tz), 2);
});

test("ISO week is Monday-start", () => {
  assert.equal(isoWeek("2026-09-14"), "2026-W38");
  assert.equal(isoWeekStart("2026-W38"), "2026-09-14");
  assert.equal(currentIsoWeek(Date.UTC(2026, 8, 16, 12), "UTC"), "2026-W38");
});

test("shiftDay and yearMonth", () => {
  assert.equal(shiftDay("2026-09-01", -1), "2026-08-31");
  assert.equal(yearMonth("2026-09-15"), "2026-09");
  assert.equal(previousMonth(Date.UTC(2026, 8, 1, 12), "UTC"), "2026-08");
});

test("overnight is last_active in 02:00–03:59", () => {
  const tz = "UTC";
  assert.equal(overnightValue(null, tz), null);
  assert.equal(overnightValue(Date.UTC(2026, 8, 16, 1, 59), tz), 0);
  assert.equal(overnightValue(Date.UTC(2026, 8, 16, 2, 0), tz), 1);
  assert.equal(overnightValue(Date.UTC(2026, 8, 16, 3, 50), tz), 1);
  assert.equal(overnightValue(Date.UTC(2026, 8, 16, 4, 0), tz), 0);
  assert.equal(overnightValue(Date.UTC(2026, 8, 15, 23, 0), tz), 0);
});

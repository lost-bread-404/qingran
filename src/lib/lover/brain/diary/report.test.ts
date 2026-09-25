import assert from "node:assert/strict";
import { test } from "node:test";
import { setClock } from "../clock.ts";
import { openIsolatedSql } from "../eval-db.ts";
import { enqueuePeriodicIfDue } from "./dusk.ts";
import { chunkByDay, loadMonthDialogue } from "./report.ts";
import { narrativeNumbersOk } from "./report-check.ts";
import { upsertMessage } from "../store.ts";

const TZ = "America/New_York";

test("narrative numbers must exist in data", () => {
  const data = { coverage: 0.4, n11: 6, lift: 2.5, days: 12 };
  assert.equal(narrativeNumbersOk("覆盖率 0.4，有 6 次，lift 2.5", data), true);
  assert.equal(narrativeNumbersOk("有 99 次", data), false);
  assert.equal(narrativeNumbersOk("没有数字也可以写感觉", data), true);
});

test("a monthly report reads the raw month and skips notices and forgotten lines", async () => {
  const iso = await openIsolatedSql();
  setClock(() => Date.parse("2026-09-15T18:00:00-04:00"));
  try {
    await upsertMessage({ id: "m1", role: "user", text: "今天好累", createdAt: Date.parse("2026-09-15T18:00:00-04:00"), timeZone: TZ });
    await upsertMessage({ id: "m2", role: "assistant", text: "过来", createdAt: Date.parse("2026-09-15T18:01:00-04:00"), timeZone: TZ });
    await upsertMessage({
      id: "m3",
      role: "assistant",
      text: "系统提示",
      createdAt: Date.parse("2026-09-15T18:02:00-04:00"),
      timeZone: TZ,
      kind: "system_notice",
    });
    await upsertMessage({ id: "m4", role: "user", text: "忘掉这句", createdAt: Date.parse("2026-09-16T18:00:00-04:00"), timeZone: TZ });
    await iso.sql.query(`update qingran_messages set forgotten_at = 1 where id = 'm4'`);
    await upsertMessage({ id: "m5", role: "user", text: "上个月的", createdAt: Date.parse("2026-08-20T18:00:00-04:00"), timeZone: TZ });
    const lines = await loadMonthDialogue("2026-09");
    assert.deepEqual(lines.map((line) => line.text), ["今天好累", "过来"]);
    const chunks = chunkByDay(lines, 10_000);
    assert.equal(chunks.length, 1);
    assert.match(chunks[0]!, /Rosie：今天好累/);
    assert.doesNotMatch(chunks[0]!, /系统提示|忘掉这句|上个月/);
  } finally {
    setClock(null);
    await iso.close();
  }
});

test("diaryEnabled false does not enqueue a monthly report", async () => {
  const iso = await openIsolatedSql();
  const nowMs = Date.parse("2026-10-01T08:00:00-04:00");
  setClock(() => nowMs);
  try {
    await enqueuePeriodicIfDue(nowMs, TZ);
    const paused = await iso.sql.query<{ type: string }>(`select type from brain_jobs`);
    assert.equal(paused.some((row) => row.type === "report" || row.type === "dusk"), false);
    await iso.sql.query(
      `insert into qingran_profile (id, data) values (1, '{"diaryEnabled":true}'::jsonb)
       on conflict (id) do update set data = qingran_profile.data || '{"diaryEnabled":true}'::jsonb`,
    );
    await enqueuePeriodicIfDue(nowMs, TZ);
    const jobs = await iso.sql.query<{ type: string; dedupe_key: string }>(`select type, dedupe_key from brain_jobs`);
    assert.deepEqual(jobs.map((row) => row.type), ["report"]);
    assert.equal(jobs[0]?.dedupe_key, "report:2026-09");
  } finally {
    setClock(null);
    await iso.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { setClock } from "../clock.ts";
import { openIsolatedSql } from "../eval-db.ts";
import { drainJobs, enqueue } from "../jobs.ts";
import { patchMeta } from "../store.ts";
import { checkSpend } from "./check.ts";
import { bumpRate, insertOverride, recordSpend, resetSpendSnap } from "./ledger.ts";
import { defaultSpendLimits } from "./policy.ts";
import { JOB_RATE_MAX, TALK_RATE_MAX, talkRateHit } from "./rate.ts";

const TZ = "America/New_York";
const at = new Date("2026-09-16T16:00:00Z").getTime();

test("spend_daily concurrent upserts add up", async () => {
  const iso = await openIsolatedSql();
  resetSpendSnap();
  try {
    setClock(() => at);
    await patchMeta({ timeZone: TZ });
    await Promise.all(
      Array.from({ length: 8 }, () => recordSpend({ kind: "llm", route: "reflect", usd: 0.25, model: "m" })),
    );
    const rows = await iso.sql.query<{ usd: number; calls: number }>(
      `select usd, calls from spend_daily where route = 'reflect'`,
    );
    assert.equal(Number(rows[0]?.calls), 8);
    assert.ok(Math.abs(Number(rows[0]?.usd) - 2) < 1e-6);
  } finally {
    setClock(null);
    await iso.close();
  }
});

test("paused job does not bump attempts and sets run_after", async () => {
  process.env.XAI_API_KEY = "mock";
  const iso = await openIsolatedSql();
  resetSpendSnap();
  try {
    setClock(() => at);
    await patchMeta({
      timeZone: TZ,
      spendLimits: { ...defaultSpendLimits(), daySoft: 0.01, dayHard: 0.02, dayBreaker: 0.03 },
    });
    await recordSpend({ kind: "llm", route: "voice", usd: 0.02, at });
    resetSpendSnap();
    await enqueue("synth", "synth:test", { week: "2026-W38" });
    const ran = await drainJobs(5_000);
    assert.equal(ran, 0);
    const jobs = await iso.sql.query<{ attempts: number; status: string; run_after: number; last_error: string }>(
      `select attempts, status, run_after, last_error from brain_jobs where dedupe_key = 'synth:test'`,
    );
    assert.equal(jobs[0]?.status, "pending");
    assert.equal(Number(jobs[0]?.attempts), 0);
    assert.ok(String(jobs[0]?.last_error).startsWith("spend:"));
    assert.ok(Number(jobs[0]?.run_after) > at);
  } finally {
    setClock(null);
    await iso.close();
  }
});

test("talk 21st request is limited; job rate trips after cap", async () => {
  const iso = await openIsolatedSql();
  resetSpendSnap();
  try {
    let limitedAt = 0;
    for (let i = 1; i <= TALK_RATE_MAX + 1; i++) {
      const r = await talkRateHit("sess");
      if (r.limited) limitedAt = i;
    }
    assert.equal(limitedAt, TALK_RATE_MAX + 1);
    for (let i = 0; i < JOB_RATE_MAX; i++) await bumpRate("jobs:test");
    const last = await bumpRate("jobs:test");
    assert.ok(last > JOB_RATE_MAX);
  } finally {
    await iso.close();
  }
});

test("checkSpend breaker blocks voice", async () => {
  const iso = await openIsolatedSql();
  resetSpendSnap();
  try {
    setClock(() => at);
    await patchMeta({
      timeZone: TZ,
      spendLimits: { ...defaultSpendLimits(), daySoft: 0.01, dayHard: 0.02, dayBreaker: 0.03 },
    });
    await recordSpend({ kind: "llm", route: "voice", usd: 0.05, at });
    resetSpendSnap();
    const d = await checkSpend("voice");
    assert.equal(d.allow, false);
    assert.equal(d.level, "breaker");
  } finally {
    setClock(null);
    await iso.close();
  }
});

test("override only lifts breaker", async () => {
  const iso = await openIsolatedSql();
  resetSpendSnap();
  try {
    setClock(() => at);
    await patchMeta({
      timeZone: TZ,
      spendLimits: { ...defaultSpendLimits(), daySoft: 0.01, dayHard: 0.02, dayBreaker: 0.03 },
    });
    await recordSpend({ kind: "llm", route: "voice", usd: 0.05, at });
    resetSpendSnap();
    await insertOverride("day", "2026-09-16", "test");
    const v = await checkSpend("voice");
    assert.equal(v.allow, true);
    assert.equal(v.level, "hard");
    const s = await checkSpend("synth");
    assert.equal(s.allow, false);
  } finally {
    setClock(null);
    await iso.close();
  }
});

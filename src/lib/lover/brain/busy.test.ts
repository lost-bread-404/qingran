import assert from "node:assert/strict";
import { test } from "node:test";
import { saveIdentityAndRefreshBusy } from "./busy.ts";
import { openIsolatedSql } from "./eval-db.ts";
import { identityHash, replaceBusyPeriods } from "./life-store.ts";

const PERIOD = {
  id: "a",
  fromDay: "2026-09-01",
  toDay: "2026-12-01",
  busy: 0.6,
  label: "学期",
  reason: "课",
};

async function pendingBusy(sql: Awaited<ReturnType<typeof openIsolatedSql>>["sql"]): Promise<number> {
  const rows = await sql.query<{ n: number }>(
    `select count(*)::int as n from brain_jobs where type = 'busy' and status = 'pending'`,
  );
  return Number(rows[0]?.n ?? 0);
}

test("a changed identity enqueues one busy refresh", async () => {
  const iso = await openIsolatedSql();
  try {
    await replaceBusyPeriods([PERIOD], identityHash("旧身份"));
    assert.equal(await saveIdentityAndRefreshBusy("科研年的研究生"), true);
    assert.equal(await pendingBusy(iso.sql), 1);
    assert.equal(await saveIdentityAndRefreshBusy("科研年的研究生"), false);
    assert.equal(await pendingBusy(iso.sql), 1);
  } finally {
    await iso.close();
  }
});

test("the same identity does not enqueue a busy refresh", async () => {
  const iso = await openIsolatedSql();
  try {
    const text = "科研年的研究生";
    await replaceBusyPeriods([PERIOD], identityHash(text));
    assert.equal(await saveIdentityAndRefreshBusy(text), false);
    assert.equal(await pendingBusy(iso.sql), 0);
  } finally {
    await iso.close();
  }
});

test("a non-empty identity with an empty table enqueues a busy refresh", async () => {
  const iso = await openIsolatedSql();
  try {
    assert.equal(await saveIdentityAndRefreshBusy("科研年的研究生"), true);
    assert.equal(await pendingBusy(iso.sql), 1);
  } finally {
    await iso.close();
  }
});

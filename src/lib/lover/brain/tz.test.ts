import assert from "node:assert/strict";
import { test } from "node:test";
import { setClock } from "./clock.ts";
import { openIsolatedSql } from "./eval-db.ts";
import { getMeta } from "./store.ts";
import { FALLBACK_TZ, resolveTz } from "./tz.ts";
import { syncTalkTimeZone } from "./log-refs.ts";

test("empty timezone falls back to New York", () => {
  assert.equal(resolveTz(""), FALLBACK_TZ);
  assert.equal(resolveTz(null), FALLBACK_TZ);
  assert.equal(resolveTz("UTC"), "UTC");
});

test("first talk writes timezone when meta is empty or different", async () => {
  const iso = await openIsolatedSql();
  try {
    setClock(() => Date.UTC(2026, 8, 17, 12, 0, 0));
    const first = await syncTalkTimeZone("Asia/Shanghai");
    assert.equal(first, "Asia/Shanghai");
    assert.equal((await getMeta()).timeZone, "Asia/Shanghai");
    const same = await syncTalkTimeZone("Asia/Shanghai");
    assert.equal(same, "Asia/Shanghai");
    const emptyKeeps = await syncTalkTimeZone("");
    assert.equal(emptyKeeps, "Asia/Shanghai");
    const changed = await syncTalkTimeZone("America/New_York");
    assert.equal(changed, "America/New_York");
    assert.equal((await getMeta()).timeZone, "America/New_York");
  } finally {
    setClock(null);
    await iso.close();
  }
});

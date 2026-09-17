import assert from "node:assert/strict";
import { test } from "node:test";
import { openIsolatedSql } from "../lover/brain/eval-db.ts";
import {
  ATTEMPT_MAX_FAILS,
  ATTEMPT_WINDOW_MS,
  clientIp,
  failAttempt,
  isLimited,
  resetAttempt,
} from "./attempts.ts";

test("clientIp uses the first x-forwarded-for hop", () => {
  assert.equal(clientIp("1.1.1.1, 2.2.2.2"), "1.1.1.1");
  assert.equal(clientIp("  9.9.9.9 "), "9.9.9.9");
  assert.equal(clientIp(null), "unknown");
});

test("fail count, limit after 5, and window reset", async () => {
  const iso = await openIsolatedSql();
  try {
    const ip = "203.0.113.9";
    const t0 = 1_700_000_000_000;
    for (let i = 1; i <= ATTEMPT_MAX_FAILS; i++) {
      const r = await failAttempt(ip, t0 + i);
      assert.equal(r.fails, i);
      assert.equal(r.limited, i >= ATTEMPT_MAX_FAILS);
    }
    assert.equal(await isLimited(ip, t0 + 10), true);
    assert.equal(await isLimited(ip, t0 + ATTEMPT_WINDOW_MS + 1), false);

    const after = await failAttempt(ip, t0 + ATTEMPT_WINDOW_MS + 5);
    assert.equal(after.fails, 1);
    assert.equal(after.limited, false);

    await resetAttempt(ip);
    assert.equal(await isLimited(ip, t0 + ATTEMPT_WINDOW_MS + 6), false);
  } finally {
    await iso.close();
  }
});

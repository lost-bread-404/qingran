import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTEMPT_MAX_FAILS, ATTEMPT_WINDOW_MS, clientIp, nextFailState } from "./attempts.ts";

test("clientIp uses the first x-forwarded-for hop", () => {
  assert.equal(clientIp("1.1.1.1, 2.2.2.2"), "1.1.1.1");
  assert.equal(clientIp("  9.9.9.9 "), "9.9.9.9");
  assert.equal(clientIp(null), "unknown");
});

test("fail count, limit after 5, and window reset", () => {
  const t0 = 1_700_000_000_000;
  let row: { fails: number; windowStart: number } | null = null;
  for (let i = 1; i <= ATTEMPT_MAX_FAILS; i++) {
    const r = nextFailState(row, t0 + i);
    assert.equal(r.fails, i);
    assert.equal(r.limited, i >= ATTEMPT_MAX_FAILS);
    row = { fails: r.fails, windowStart: r.windowStart };
  }
  assert.equal(nextFailState(row, t0 + 10).limited, true);
  const after = nextFailState(row, t0 + ATTEMPT_WINDOW_MS + 5);
  assert.equal(after.fails, 1);
  assert.equal(after.limited, false);
  assert.equal(after.windowStart, t0 + ATTEMPT_WINDOW_MS + 5);
});

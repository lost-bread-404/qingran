import assert from "node:assert/strict";
import { test } from "node:test";
import { openIsolatedSql } from "./eval-db.ts";
import { getReach, lastVisibleMessageAt, saveReach } from "./life-store.ts";
import type { callModel } from "./llm.ts";
import { runWake } from "./reach.ts";

const TEN_MIN = 10 * 60_000;

function fakeReach(send: boolean): typeof callModel {
  const json = {
    send,
    text: send ? "学完了吗" : "",
    feel: "想她",
    want: "听她说",
    now: "问一句",
    longings: [],
    glow: { delta: 0, why: "" },
    next_reach: { in_hours: 10 / 60, intent: "再问一次" },
  };
  return (async () => ({
    ok: true,
    text: JSON.stringify(json),
    json,
    toolCalls: [],
    raw: {},
    model: "test",
    effort: "low" as const,
    ms: 1,
  })) as typeof callModel;
}

test("last visible chat ignores proactive pings and system notices", async () => {
  const iso = await openIsolatedSql();
  const t = Date.UTC(2026, 8, 24, 15, 0, 0);
  try {
    await iso.sql.query(
      `insert into qingran_messages (id, role, body, created_at, kind) values
       ('u', 'user', '在吗', $1, 'say'),
       ('a', 'assistant', '在', $2, 'say'),
       ('p', 'assistant', '想你', $3, 'proactive'),
       ('n', 'assistant', '没发出去', $4, 'system_notice')`,
      [t, t + 1_000, t + 2_000, t + 3_000],
    );
    assert.equal(await lastVisibleMessageAt(), t + 1_000);
  } finally {
    await iso.close();
  }
});

test("a sent reach counts itself, and a recent ping does not look like chatting", async () => {
  const iso = await openIsolatedSql();
  const at = Date.UTC(2026, 8, 24, 18, 0, 0);
  let calls = 0;
  const complete = (async (...args: Parameters<typeof callModel>) => {
    calls += 1;
    return fakeReach(true)(...args);
  }) as typeof callModel;
  try {
    await iso.sql.query(
      `insert into qingran_messages (id, role, body, created_at, kind) values
       ('u', 'user', '去学习了', $1, 'say'),
       ('p', 'assistant', '学得怎么样', $2, 'proactive')`,
      [at - 2 * 60 * 60_000, at - 60_000],
    );
    await saveReach({ nextAt: at - 1_000, intent: "等她学完", setBy: "reflect", setAt: at - 3_600_000, retry: 0 });
    const result = await runWake({ at, complete });
    assert.equal(calls, 1);
    assert.equal(result.sent, true);
    assert.equal((await getReach()).nextAt, at + 2 * TEN_MIN);
  } finally {
    await iso.close();
  }
});

test("a reach that does not send keeps the previous unanswered count", async () => {
  const iso = await openIsolatedSql();
  const at = Date.UTC(2026, 8, 24, 21, 0, 0);
  try {
    await iso.sql.query(
      `insert into qingran_messages (id, role, body, created_at, kind) values
       ('u', 'user', '去学习了', $1, 'say'),
       ('p', 'assistant', '学得怎么样', $2, 'proactive')`,
      [at - 2 * 60 * 60_000, at - 40 * 60_000],
    );
    await saveReach({ nextAt: at - 1_000, intent: "等她学完", setBy: "reflect", setAt: at - 4 * 60 * 60_000, retry: 0 });
    const result = await runWake({ at, complete: fakeReach(false) });
    assert.equal(result.sent, false);
    assert.equal((await getReach()).nextAt, at + TEN_MIN);
  } finally {
    await iso.close();
  }
});

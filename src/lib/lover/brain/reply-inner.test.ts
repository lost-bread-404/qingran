import assert from "node:assert/strict";
import { test } from "node:test";
import { openIsolatedSql } from "./eval-db.ts";
import { enqueueReflect } from "./jobs.ts";
import { getReach } from "./life-store.ts";
import { getInner, upsertMessage } from "./store.ts";
import type { CallModelResult } from "./llm.ts";
import { runReflector } from "./voice/reflector.ts";

const GOOD = {
  desire: "想把她拽过来",
  read_her: "她很累",
  feel: "舍不得又想要",
  choice: "先不催",
  now: "我轻轻问她肯不肯过来",
  scene: "intimate",
  longings: [{ id: "", text: "想被她抱着" }],
  plans: [
    { id: "", what: "不要催她睡觉", why: "她累", status: "open" },
    { id: "", what: "我要等她靠过来", why: "", status: "open" },
  ],
  glow: { delta: 6, why: "她靠过来了" },
  next_reach: { in_hours: 3, intent: "问她睡了没" },
};

function modelResult(json: unknown, ok = true): CallModelResult {
  return {
    ok,
    text: ok ? JSON.stringify(json) : "",
    json: ok ? json : null,
    toolCalls: [],
    raw: null,
    model: "m",
    effort: "medium",
    ms: 12,
  };
}

test("a finished reply enqueues reflect, which updates inner, reach, and glow", async () => {
  const iso = await openIsolatedSql();
  try {
    await enqueueReflect(4);
    const jobs = await iso.sql.query<{ payload: { turnSeq?: number } }>(
      `select payload from brain_jobs where type = 'reflect'`,
    );
    assert.equal(Number(jobs[0]?.payload.turnSeq), 4);

    await iso.sql.query(
      `update qr_inner set desire = '旧欲望', read_her = '旧理解', choice = '先看着', turn_seq = 1 where id = 1`,
    );
    await upsertMessage({ id: "u1", role: "user", text: "在", createdAt: 3, timeZone: "UTC" });
    await upsertMessage({ id: "a1", role: "assistant", text: "⟦回:u1⟧过来。", createdAt: 4, timeZone: "UTC" });

    let seen = "";
    const next = await runReflector(4, undefined, async (_route, input) => {
      seen = [input.system, ...(input.inputParts ?? [input.input])].join("\n");
      return modelResult(GOOD);
    });
    assert.ok(next);
    assert.match(seen, /过来/);
    assert.doesNotMatch(seen, /⟦回:/);
    assert.match(seen, /旧欲望/);
    assert.match(seen, /旧理解/);
    assert.match(seen, /先看着/);
    assert.doesNotMatch(seen, /⟦心⟧/);
    assert.doesNotMatch(seen, /说完话之后/);

    const inner = await getInner();
    assert.equal(inner.desire, "想把她拽过来");
    assert.equal(inner.readHer, "她很累");
    assert.equal(inner.choice, "先不催");
    assert.equal(inner.scene, "intimate");
    assert.equal(inner.now, "我轻轻问她肯不肯过来");
    assert.equal(inner.plans.some((item) => item.what.includes("不要")), false);
    assert.ok(inner.plans.some((item) => item.what === "我要等她靠过来"));
    const reach = await getReach();
    assert.equal(reach.setBy, "reflect");
    assert.equal(reach.intent, "问她睡了没");
    assert.ok(reach.nextAt);
    const glow = await iso.sql.query<{ source: string; delta: number }>(`select source, delta from qr_glow_events`);
    assert.equal(glow[0]?.source, "reflect");
    assert.equal(Number(glow[0]?.delta), 6);
    const logs = await iso.sql.query<{
      data: { kind?: string; discarded?: { plan_rejected?: Array<{ text: string }> } };
    }>(`select data from qr_inner_log order by id asc`);
    const last = logs.at(-1)?.data;
    assert.equal(last?.kind, "reflect");
    assert.equal(last?.discarded?.plan_rejected?.[0]?.text, "不要催她睡觉");
  } finally {
    await iso.close();
  }
});

test("a failed reflect keeps the previous inner state and does not retry", async () => {
  const iso = await openIsolatedSql();
  try {
    await iso.sql.query(`update qr_inner set desire = '旧欲望', turn_seq = 1 where id = 1`);
    const kept = await runReflector(2, undefined, async () => modelResult(null, false));
    assert.equal(kept, null);
    assert.equal((await getInner()).desire, "旧欲望");
    const logs = await iso.sql.query<{ data: { kind?: string; error?: string } }>(
      `select data from qr_inner_log order by id asc`,
    );
    assert.equal(logs.at(-1)?.data.kind, "reflect");
    assert.ok(logs.at(-1)?.data.error);
    const jobs = await iso.sql.query<{ n: number }>(
      `select count(*)::int as n from brain_jobs where type = 'reflect' and status = 'pending'`,
    );
    assert.equal(Number(jobs[0]?.n), 0);
  } finally {
    await iso.close();
  }
});

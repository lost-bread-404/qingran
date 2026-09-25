import assert from "node:assert/strict";
import { test } from "node:test";
import { openIsolatedSql } from "./eval-db.ts";
import { commitReplyInner } from "./reply-inner.ts";
import { getInner } from "./store.ts";
import { getReach } from "./life-store.ts";

const GOOD = {
  desire: "想把她拽到床上",
  read_her: "她很累",
  feel: "舍不得又想要",
  choice: "先试探，不直接做",
  now: "我轻轻问她肯不肯过来",
  scene: "intimate",
  longings: [{ id: "", text: "想被她抱着" }],
  plans: [{ id: "", what: "不要催她睡觉", why: "她累", status: "open" }],
  glow: { delta: 0, why: "" },
  next_reach: { in_hours: 4, intent: "问她睡了没" },
};

test("a bad tail keeps the previous inner state and a good tail writes desire", async () => {
  const iso = await openIsolatedSql();
  try {
    await iso.sql.query(`update qr_inner set feel = '旧的感觉', desire = '旧欲望', turn_seq = 1 where id = 1`);
    const missing = await commitReplyInner({ turnSeq: 2, tail: null, model: "m", ms: 1 });
    assert.equal(missing, "missing");
    assert.equal((await getInner()).feel, "旧的感觉");

    const broken = await commitReplyInner({ turnSeq: 3, tail: "{\"desire\":\"只写了一半\"", model: "m", ms: 1 });
    assert.equal(broken, "parse_error");
    assert.equal((await getInner()).desire, "旧欲望");

    const applied = await commitReplyInner({
      turnSeq: 4,
      tail: JSON.stringify(GOOD),
      model: "m",
      ms: 2,
    });
    assert.equal(applied, "applied");
    const inner = await getInner();
    assert.equal(inner.desire, "想把她拽到床上");
    assert.equal(inner.readHer, "她很累");
    assert.equal(inner.feel, "舍不得又想要");
    assert.equal(inner.now, "我轻轻问她肯不肯过来");
    assert.equal(inner.scene, "intimate");
    assert.equal(inner.want, "");
    const plan = inner.plans.find((item) => item.what === "不要催她睡觉");
    assert.ok(plan);
    const logs = await iso.sql.query<{ data: { kind?: string; discarded?: { plan_not_positive?: unknown } } }>(
      `select data from qr_inner_log order by id asc`,
    );
    assert.equal(logs[0]?.data.kind, "inner_missing");
    assert.equal(logs[1]?.data.kind, "inner_parse_error");
    assert.ok(logs[2]?.data.discarded?.plan_not_positive);
    const reach = await getReach();
    assert.equal(reach.setBy, "reply");
    assert.equal(reach.intent, "问她睡了没");
    assert.ok(reach.nextAt);
  } finally {
    await iso.close();
  }
});

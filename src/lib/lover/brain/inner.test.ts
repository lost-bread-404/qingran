import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PLAN_OPEN_MAX } from "./config.ts";
import { openIsolatedSql } from "./eval-db.ts";
import {
  applyReflectOutput,
  expireOpenPlans,
  nowNotActionReason,
  nowRejectedReason,
  REFLECT_OUTPUT_KEYS,
} from "./mind-parse.ts";
import { INNER_SCHEMA } from "./voice/reflector.ts";
import { EMPTY_INNER, type InnerPlan, type InnerState } from "./types.ts";

function plan(partial: Partial<InnerPlan> & Pick<InnerPlan, "id">): InnerPlan {
  return {
    what: partial.what ?? "做这件事",
    why: partial.why ?? "",
    trigger: partial.trigger,
    expires_at: partial.expires_at,
    status: partial.status ?? "open",
    id: partial.id,
  };
}

test("reflect schema leads with desire, then read_her, and the voice path hides both read_her and choice", () => {
  assert.deepEqual([...INNER_SCHEMA.schema.required], [...REFLECT_OUTPUT_KEYS]);
  assert.deepEqual(REFLECT_OUTPUT_KEYS.slice(0, 5), ["desire", "read_her", "feel", "choice", "now"]);
  const observed = applyReflectOutput(
    EMPTY_INNER,
    { desire: "想把她拽过来", read_her: "她很累", feel: "舍不得又想要", choice: "先试探，不直接做", now: "她只回了一个字" },
    10,
    1,
  );
  assert.equal(observed.next.now, "她只回了一个字");
  assert.equal(observed.next.desire, "想把她拽过来");
  assert.equal(observed.next.readHer, "她很累");
  assert.ok(observed.discarded.now_not_action);
  const acted = applyReflectOutput(EMPTY_INNER, { now: "我轻轻问她肯不肯过来" }, 10, 2);
  assert.equal(nowNotActionReason("我轻轻问她肯不肯过来"), null);
  assert.equal(acted.discarded.now_not_action, undefined);
  assert.equal(acted.next.now, "我轻轻问她肯不肯过来");
});

test("migration copies want into desire and keeps the old column", async () => {
  const iso = await openIsolatedSql();
  try {
    await iso.sql.query(`update qr_inner set want = '想把她拽过来', desire = '' where id = 1`);
    const file = readFileSync(new URL("../../../../migrations/0030_inner_desire.sql", import.meta.url), "utf8");
    for (const statement of file.split(";").map((part) => part.trim()).filter(Boolean)) {
      await iso.sql.query(statement);
    }
    const rows = await iso.sql.query<{ desire: string; want: string }>(`select desire, want from qr_inner where id = 1`);
    assert.equal(rows[0]!.desire, "想把她拽过来");
    assert.equal(rows[0]!.want, "想把她拽过来");
  } finally {
    await iso.close();
  }
});

test("now rejection catches negative intent and keeps 特别 别人 别的", () => {
  for (const text of ["不要催她", "别再提学习", "别催", "不再问", "没有再提", "不去管", "不会再问", "不能催", "不催她", "停止追问", "避免提起"]) {
    assert.ok(nowRejectedReason(text), text);
  }
  assert.equal(nowRejectedReason("特别想抱着你"), null);
  assert.equal(nowRejectedReason("别人来了我也在"), null);
  assert.equal(nowRejectedReason("别的事先放着，先听你说"), null);
  assert.equal(nowRejectedReason("想抱着你，听你把今天说完"), null);
  assert.equal(nowRejectedReason(""), null);
});

test("rejected now is wiped and the rest is kept", () => {
  const prev: InnerState = { ...EMPTY_INNER, longing: "旧的惦记", longing_updated_at: 5, plans: [] };
  const { next, discarded } = applyReflectOutput(
    prev,
    { feel: "想靠近", want: "想被靠着", choice: "先不催", now: "不要催她学习", longing: "旧的惦记", plans: [] },
    100,
    9,
  );
  assert.equal(next.now, "");
  assert.equal(next.feel, "想靠近");
  assert.equal(next.choice, "先不催");
  assert.equal(next.longing_updated_at, 5);
  assert.ok(discarded.now_rejected);
});

test("plan ids stay, empty ids are generated, and the open cap drops the earliest", () => {
  const nowMs = 1_000_000;
  const prev = [
    plan({ id: "keep-me", what: "旧计划" }),
    plan({ id: "old-open", what: "没被模型提到" }),
  ];
  const raw = [
    { id: "keep-me", what: "旧计划还在", why: "还想", status: "open" },
    { id: "", what: "新的", why: "", status: "open" },
    { id: "due", what: "已经到点", why: "不看钟", status: "open" },
    ...Array.from({ length: PLAN_OPEN_MAX - 2 }, (_, i) => ({
      id: `extra-${i}`,
      what: `多出来的${i}`,
      why: "",
      status: "open",
    })),
  ];
  const { next, discarded } = applyReflectOutput({ ...EMPTY_INNER, plans: prev }, { plans: raw }, nowMs, 3);
  const kept = next.plans.find((item) => item.id === "keep-me");
  assert.equal(kept?.what, "旧计划还在");
  const generated = next.plans.find((item) => item.what === "新的");
  assert.ok(generated);
  assert.notEqual(generated!.id, "");
  assert.equal(next.plans.find((item) => item.id === "due")?.status, "open");
  assert.equal(next.plans.filter((item) => item.status === "open").length, PLAN_OPEN_MAX);
  const drops = discarded.plans as Array<{ id: string; reason: string }>;
  assert.ok(drops.every((item) => item.reason === "open_cap"));
  assert.equal(drops[0]?.id, "keep-me");
});

test("open plans are not dropped just because an old expires_at passed", () => {
  const nowMs = 5_000;
  const { plans, dropped } = expireOpenPlans(
    [plan({ id: "a", expires_at: 4_000 }), plan({ id: "b", expires_at: 9_000, status: "done" })],
    nowMs,
  );
  assert.equal(plans[0]!.status, "open");
  assert.equal(plans[1]!.status, "done");
  assert.deepEqual(dropped, []);
});

test("a negative plan is kept and only logged", () => {
  const { next, discarded } = applyReflectOutput(
    EMPTY_INNER,
    { plans: [{ id: "", what: "不要催她", why: "她累", status: "open" }] },
    10,
    1,
  );
  assert.equal(next.plans[0]?.what, "不要催她");
  const logged = discarded.plan_not_positive as Array<{ text: string }>;
  assert.equal(logged[0]?.text, "不要催她");
});

test("longing timestamp moves only when the text changes", () => {
  const prev: InnerState = { ...EMPTY_INNER, longing: "同一句", longing_updated_at: 20 };
  const same = applyReflectOutput(prev, { longing: "同一句", plans: [] }, 80, 1).next;
  assert.equal(same.longing_updated_at, 20);
  const changed = applyReflectOutput(prev, { longing: "另一句", plans: [] }, 80, 2).next;
  assert.equal(changed.longing_updated_at, 80);
});

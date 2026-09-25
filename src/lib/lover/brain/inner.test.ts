import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_OPEN_MAX } from "./config.ts";
import {
  applyReflectOutput,
  expireOpenPlans,
  nowRejectedReason,
} from "./mind-parse.ts";
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

test("longing timestamp moves only when the text changes", () => {
  const prev: InnerState = { ...EMPTY_INNER, longing: "同一句", longing_updated_at: 20 };
  const same = applyReflectOutput(prev, { longing: "同一句", plans: [] }, 80, 1).next;
  assert.equal(same.longing_updated_at, 20);
  const changed = applyReflectOutput(prev, { longing: "另一句", plans: [] }, 80, 2).next;
  assert.equal(changed.longing_updated_at, 80);
});

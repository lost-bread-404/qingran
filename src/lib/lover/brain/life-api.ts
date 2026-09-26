import { createServerFn } from "@tanstack/react-start";
import { now } from "./clock.ts";
import { wakeOnce } from "./reach.ts";
import { sendApns } from "../push/apns.ts";
import { getInner, saveInner } from "./store.ts";
import type { InnerPlan, LongingItem } from "./types.ts";
import type { Effort } from "./config.ts";
import { adoptPersona, listPersonaVersions, listReplayTargets, runReplay } from "./voice/replay.ts";
import {
  addReachPlan,
  clearReachPlans,
  getReach,
  listReachPlans,
  removeReachPlan,
  insertManualEdit,
  innerSnapshot,
  listReachLog,
  profileClockZone,
  reachCountsToday,
  saveReach,
  listManualEdits,
  writeIdentity,
} from "./life-store.ts";

export const brainGetLife = createServerFn({ method: "GET" }).handler(async () => {
  const at = now();
  const zone = await profileClockZone();
  const { listPlans } = await import("./heart.ts");
  const [reach, plans, log, counts] = await Promise.all([getReach(), listPlans(), listReachLog(30), reachCountsToday(zone, at)]);
  return {
    reach,
    // Only timed plans can make him message her.
    plans: plans.filter((p) => p.at != null).map((p) => ({ id: p.id, at: p.at as number, intent: p.text, setBy: p.setBy, setAt: p.setAt })),
    log: log.map((row) => JSON.parse(JSON.stringify(row))),
    counts,
  };
});

export const brainSaveIdentity = createServerFn({ method: "POST" })
  .validator((input: { identity: string }) => input)
  .handler(async ({ data }) => {
    // The busy table is no longer generated; what he did is improvised when she asks.
    await writeIdentity(String(data.identity ?? ""));
    return { ok: true as const, queued: false };
  });

export const brainSetReach = createServerFn({ method: "POST" })
  .validator(
    (input: { enabled?: boolean; add?: { at: number; intent: string }; remove?: number; clear?: boolean }) => input,
  )
  .handler(async ({ data }) => {
    const at = now();
    const before = { reach: await getReach(), plans: await listReachPlans() };
    if (data.enabled !== undefined) await saveReach({ enabled: data.enabled });
    if (data.clear) await clearReachPlans();
    if (typeof data.remove === "number") await removeReachPlan(data.remove);
    if (data.add && Number.isFinite(data.add.at)) {
      await addReachPlan({ at: data.add.at, intent: String(data.add.intent ?? ""), setBy: "rosie", setAt: at });
    }
    const after = { reach: await getReach(), plans: await listReachPlans() };
    await insertManualEdit("reach", before, after);
    return { ok: true as const, ...after };
  });

export const brainWakeNow = createServerFn({ method: "POST" }).handler(async () => {
  const result = await wakeOnce({ manual: true });
  return result;
});

export const brainTestPush = createServerFn({ method: "POST" }).handler(async () => {
  const push = await sendApns({ body: "这是一条测试通知。", messageId: "test" });
  return { ok: true as const, push };
});

export const brainSaveHeart = createServerFn({ method: "POST" })
  .validator((input: {
    desire?: string;
    readHer?: string;
    feel?: string;
    now?: string;
    choice?: string;
    plans?: InnerPlan[];
    longings?: LongingItem[];
  }) => input)
  .handler(async ({ data }) => {
    const inner = await getInner();
    const before = innerSnapshot(inner);
    const next = {
      ...inner,
      desire: data.desire === undefined ? inner.desire : String(data.desire).slice(0, 1200),
      readHer: data.readHer === undefined ? inner.readHer : String(data.readHer).slice(0, 1200),
      feel: data.feel === undefined ? inner.feel : String(data.feel).slice(0, 1200),
      now: data.now === undefined ? inner.now : String(data.now).slice(0, 1200),
      choice: data.choice === undefined ? inner.choice : String(data.choice).slice(0, 1200),
      plans: Array.isArray(data.plans) ? data.plans.slice(0, 12) : inner.plans,
      longings: Array.isArray(data.longings) ? data.longings.slice(0, 5) : inner.longings,
    };
    next.longing = next.longings.map((item) => item.text).filter(Boolean).join("；");
    const bumped = inner.turn_seq + 1;
    await saveInner({ ...next, turn_seq: bumped }, bumped);
    await insertManualEdit("inner", before, innerSnapshot(next));
    return { ok: true as const };
  });

export const brainListManualEdits = createServerFn({ method: "GET" }).handler(async () => {
  const rows = await listManualEdits(40);
  return rows.map((row) => JSON.parse(JSON.stringify(row)));
});

export const brainListReplayTargets = createServerFn({ method: "GET" }).handler(async () => {
  return listReplayTargets(20);
});

export const brainReplayCompare = createServerFn({ method: "POST" })
  .validator((input: {
    userMsgId?: string;
    persona?: string;
    placement?: string;
    model?: string;
    effort?: string | null;
  }) => input)
  .handler(async ({ data }) => {
    const effort: Effort =
      data.effort === "low" || data.effort === "medium" || data.effort === "high" || data.effort === "none" || data.effort === null
        ? data.effort
        : "low";
    return runReplay({
      userMsgId: String(data.userMsgId ?? ""),
      bPersona: String(data.persona ?? ""),
      bPlacement: data.placement === "first_user" ? "first_user" : "system",
      bModel: String(data.model ?? ""),
      bEffort: effort,
    });
  });

export const brainAdoptPersona = createServerFn({ method: "POST" })
  .validator((input: { persona?: string }) => input)
  .handler(async ({ data }) => {
    await adoptPersona(String(data.persona ?? ""));
    return { ok: true as const };
  });

export const brainListPersonaVersions = createServerFn({ method: "GET" }).handler(async () => {
  return listPersonaVersions(8);
});

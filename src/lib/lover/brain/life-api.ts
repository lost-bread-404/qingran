import { createServerFn } from "@tanstack/react-start";
import { now } from "./clock.ts";
import { wakeOnce } from "./reach.ts";
import { sendApns } from "../push/apns.ts";
import type { Effort } from "./config.ts";
import { adoptPersona, listPersonaVersions, listReplayDays, listReplayTargets, runReplay } from "./voice/replay.ts";
import {
  getReach,
  insertManualEdit,
  listReachLog,
  profileClockZone,
  reachCountsToday,
  saveReach,
  listManualEdits,
} from "./life-store.ts";

export const brainGetLife = createServerFn({ method: "GET" }).handler(async () => {
  const at = now();
  const zone = await profileClockZone();
  const [reach, log, counts] = await Promise.all([getReach(), listReachLog(30), reachCountsToday(zone, at)]);
  return {
    reach,
    log: log.map((row) => JSON.parse(JSON.stringify(row))),
    counts,
  };
});

export const brainSetReach = createServerFn({ method: "POST" })
  .validator((input: { enabled?: boolean }) => input)
  .handler(async ({ data }) => {
    const before = { reach: await getReach() };
    if (data.enabled !== undefined) await saveReach({ enabled: data.enabled });
    const after = { reach: await getReach() };
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

export const brainListManualEdits = createServerFn({ method: "GET" }).handler(async () => {
  const rows = await listManualEdits(40);
  return rows.map((row) => JSON.parse(JSON.stringify(row)));
});

export const brainListReplayTargets = createServerFn({ method: "POST" })
  .validator((input: { day?: string | null } | undefined) => input ?? {})
  .handler(async ({ data }) => {
    const day = typeof data.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.day) ? data.day : null;
    return listReplayTargets(60, day);
  });

export const brainListReplayDays = createServerFn({ method: "GET" }).handler(async () => listReplayDays());

export const brainReplayCompare = createServerFn({ method: "POST" })
  .validator((input: {
    userMsgId?: string;
    persona?: string;
    placement?: string;
    model?: string;
    effort?: string | null;
  }) => input)
  .handler(async ({ data }) => {
    // Whatever the picker offers (Claude goes up to max); replay clamps it to what the model takes.
    const effort: Effort =
      data.effort === "none" ||
      data.effort === "low" ||
      data.effort === "medium" ||
      data.effort === "high" ||
      data.effort === "xhigh" ||
      data.effort === "max" ||
      data.effort === null
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

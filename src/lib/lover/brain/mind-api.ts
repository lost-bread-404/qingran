import { createServerFn } from "@tanstack/react-start";
import { now } from "./clock.ts";
import { getMeta, getProfileData } from "./store.ts";
import { resolveTz } from "./tz.ts";
import { lockedProfile } from "../types.ts";
import { localDay } from "./time.ts";
import { effectiveMode, recordMode } from "./mode.ts";
import { insertManualEdit } from "./life-store.ts";
import { runInBackground } from "./wait-until.ts";
import { LONG_DRAIN_MS } from "./config.ts";
import { addPlan, formatLocal, getHeart, listPlans, parseLocalTime, recentDays, removePlan, saveDayTimeline, setFocus, setHeart, todayText } from "./heart.ts";

/** Settings → 他的心: everything the brain holds, readable and editable. */
export const brainGetMind = createServerFn({ method: "GET" }).handler(async () => {
  const at = now();
  const tz = resolveTz((await getMeta()).timeZone);
  const profile = lockedProfile(await getProfileData());
  const [heart, plans, days, current, today] = await Promise.all([
    getHeart(),
    listPlans(),
    recentDays(14, localDay(at, tz)),
    effectiveMode(at, tz, profile.modes.map((m) => m.id)),
    todayText(at, tz),
  ]);
  return {
    timeZone: tz,
    heart: { text: heart.text, focus: heart.focus, updatedAt: heart.updatedAt },
    plans: plans.map((p) => ({
      id: p.id,
      at: p.at,
      atText: p.at == null ? "" : formatLocal(p.at, tz),
      due: p.at != null && p.at <= at,
      text: p.text,
      setBy: p.setBy,
    })),
    today,
    days: days.reverse(),
    mode: current,
    modes: profile.modes.map((m) => ({ id: m.id, name: m.name })),
  };
});

export const brainSaveHeartText = createServerFn({ method: "POST" })
  .validator((input: { text: string }) => ({ text: String(input?.text ?? "") }))
  .handler(async ({ data }) => {
    const before = await getHeart();
    await setHeart(data.text.trim(), now());
    await insertManualEdit("heart", { text: before.text }, { text: data.text.trim() });
    return { ok: true as const };
  });

export const brainSaveFocus = createServerFn({ method: "POST" })
  .validator((input: { text: string }) => ({ text: String(input?.text ?? "") }))
  .handler(async ({ data }) => {
    await setFocus(data.text.trim());
    return { ok: true as const };
  });

export const brainEditPlan = createServerFn({ method: "POST" })
  .validator((input: { add?: { text: string; at?: string }; remove?: number }) => input ?? {})
  .handler(async ({ data }) => {
    const at = now();
    const tz = resolveTz((await getMeta()).timeZone);
    if (typeof data.remove === "number") await removePlan(data.remove);
    if (data.add && String(data.add.text ?? "").trim()) {
      await addPlan({ text: String(data.add.text).trim(), at: parseLocalTime(data.add.at, tz), setBy: "rosie", setAt: at });
    }
    await insertManualEdit("plan", null, data);
    return { ok: true as const };
  });

/** 他的心 → 今天: she can correct today's text by hand. */
export const brainSaveToday = createServerFn({ method: "POST" })
  .validator((input: { text: string }) => ({ text: String(input?.text ?? "") }))
  .handler(async ({ data }) => {
    const at = now();
    const tz = resolveTz((await getMeta()).timeZone);
    const before = await todayText(at, tz);
    await saveDayTimeline(localDay(at, tz), data.text.trim(), at);
    await insertManualEdit("today", { text: before }, { text: data.text.trim() });
    return { ok: true as const };
  });

export const brainSetModeNow = createServerFn({ method: "POST" })
  .validator((input: { mode: string }) => ({ mode: String(input?.mode ?? "") }))
  .handler(async ({ data }) => {
    const profile = lockedProfile(await getProfileData());
    if (!profile.modes.some((m) => m.id === data.mode)) return { ok: false as const };
    await recordMode({ at: now(), mode: data.mode, until: null, why: "她在设置里改的" });
    return { ok: true as const };
  });

/** 整理今天：fold today into the memory now (plans and heart stay). Runs after the response. */
export const brainNightNow = createServerFn({ method: "POST" }).handler(async () => {
  const { enqueueNightNow } = await import("./night.ts");
  const { drainJobs } = await import("./jobs.ts");
  const day = await enqueueNightNow();
  await runInBackground(() => drainJobs(LONG_DRAIN_MS));
  return { ok: true as const, day };
});

import { createServerFn } from "@tanstack/react-start";
import { now } from "./clock.ts";
import { getMeta, getProfileData, sql } from "./store.ts";
import { resolveTz } from "./tz.ts";
import { lockedProfile } from "../types.ts";
import { clockOf } from "./day-notes.ts";
import { localDay } from "./time.ts";
import { effectiveMode, recordMode } from "./mode.ts";
import { insertManualEdit } from "./life-store.ts";
import { runInBackground } from "./wait-until.ts";
import { LONG_DRAIN_MS } from "./config.ts";
import { addPlan, dayWindow, formatLocal, getHeart, listPlans, parseLocalTime, recentDays, removePlan, setHeart } from "./heart.ts";

/** Settings → 他的心: everything the brain holds, readable and editable. */
export const brainGetMind = createServerFn({ method: "GET" }).handler(async () => {
  const at = now();
  const tz = resolveTz((await getMeta()).timeZone);
  const profile = lockedProfile(await getProfileData());
  const { from } = dayWindow(localDay(at, tz), tz);
  const db = await sql();
  const [heart, plans, days, current, notes] = await Promise.all([
    getHeart(),
    listPlans(),
    recentDays(14),
    effectiveMode(at, tz, profile.modes.map((m) => m.id)),
    db.query<{ id: number; at: number; text: string }>(
      `select id, at::float8 as at, text from qr_day_notes where at >= $1 order by at asc, id asc`,
      [from],
    ),
  ]);
  return {
    timeZone: tz,
    heart: { text: heart.text, updatedAt: heart.updatedAt },
    plans: plans.map((p) => ({
      id: p.id,
      at: p.at,
      atText: p.at == null ? "" : formatLocal(p.at, tz),
      due: p.at != null && p.at <= at,
      text: p.text,
      setBy: p.setBy,
    })),
    today: notes.map((n) => ({ id: Number(n.id), clock: clockOf(Number(n.at), tz), text: String(n.text) })),
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

export const brainDeleteDayNote = createServerFn({ method: "POST" })
  .validator((input: { id: number }) => ({ id: Number(input?.id) }))
  .handler(async ({ data }) => {
    if (!Number.isFinite(data.id)) return { ok: false as const };
    const db = await sql();
    await db.query(`delete from qr_day_notes where id = $1`, [data.id]);
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

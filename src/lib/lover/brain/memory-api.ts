import { createServerFn } from "@tanstack/react-start";
import { now } from "./clock.ts";

/** Settings → 记忆 → 你的抱怨: what the night pass found, newest first (for Rosie only; 清然 never sees it). */
export const brainGetFeedback = createServerFn({ method: "GET" }).handler(async () => {
  const { sql } = await import("./store.ts");
  const db = await sql();
  const rows = await db.query<{ id: number; day: string; body: string }>(
    `select id, day, body from qr_feedback order by at desc, id desc limit 60`,
  );
  return { items: rows.map((r) => ({ id: Number(r.id), day: String(r.day ?? ""), body: String(r.body ?? "") })) };
});

/**
 * 「现在整理一次」: the dossier is rewritten from the day so far (the first time, the old memories and the storyline
 * are folded in too). Runs in the background: it can take a minute or two.
 */
export const brainRunNightNow = createServerFn({ method: "POST" }).handler(async () => {
  const [{ enqueue, drainJobs }, { getProfileData }, { lockedProfile }, { runInBackground }, { LONG_DRAIN_MS }] = await Promise.all([
    import("./jobs.ts"),
    import("./store.ts"),
    import("../types.ts"),
    import("./wait-until.ts"),
    import("./config.ts"),
  ]);
  if (!lockedProfile(await getProfileData()).brainOn) return { ok: false as const, error: "记忆暂停着（设置里「运行记忆」关了）。" };
  const at = now();
  await enqueue("night", `night-now:${at}`, { v: 7, upto: at, dossierOnly: true });
  await runInBackground(() => drainJobs(LONG_DRAIN_MS));
  return { ok: true as const };
});

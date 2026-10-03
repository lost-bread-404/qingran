import { createServerFn } from "@tanstack/react-start";
import { now } from "./clock.ts";
import { insertManualEdit } from "./life-store.ts";
import { deleteMemory, listMemories, memoryCounts, updateMemory } from "./memory.ts";

/** Settings → 记忆: every moment he keeps, newest first. */
export const brainGetMemories = createServerFn({ method: "GET" }).handler(async () => {
  const [memories, counts] = await Promise.all([listMemories(), memoryCounts()]);
  const { nextNightDay } = await import("./night.ts");
  return { memories: memories.reverse(), counts, pendingDay: await nextNightDay(now()) };
});

export const brainEditMemory = createServerFn({ method: "POST" })
  .validator((input: { id: number; body?: string; changed?: string; remove?: boolean }) => input)
  .handler(async ({ data }) => {
    const id = Number(data.id);
    if (!Number.isFinite(id)) return { ok: false as const };
    const before = (await listMemories()).find((m) => m.id === id) ?? null;
    if (data.remove) await deleteMemory(id);
    else await updateMemory(id, { body: data.body, changed: data.changed });
    await insertManualEdit("memory", before, data);
    return { ok: true as const };
  });

/**
 * 「现在整理」: the days that ended and are not in his memory yet (oldest first, while there is time), then today up to
 * now, the same way a long day is folded early, except the reply keeps all of today's talk (keepFrom 0). The pass
 * at the end of today then only reads what came after.
 */
export const brainRunNightNow = createServerFn({ method: "POST" }).handler(async () => {
  const [{ enqueueMemoryWork, nextNightDay }, { enqueue, runJobsNow }, { getMark }, { getMeta, getProfileData }, { localDay }, { resolveTz }, { lockedProfile }] =
    await Promise.all([
      import("./night.ts"),
      import("./jobs.ts"),
      import("./memory.ts"),
      import("./store.ts"),
      import("./time.ts"),
      import("./tz.ts"),
      import("../types.ts"),
    ]);
  if (!lockedProfile(await getProfileData()).brainOn) return { ok: false as const, done: [], pendingDay: null, error: "记忆暂停着（设置里「运行记忆」关了）。" };
  const started = Date.now();
  const done: string[] = [];
  while (Date.now() - started < 30_000) {
    const day = await enqueueMemoryWork(now());
    if (!day || done.includes(day)) break;
    await runJobsNow();
    done.push(day);
  }
  const pendingDay = await nextNightDay(now());
  if (!pendingDay) {
    const at = now();
    const today = localDay(at, resolveTz((await getMeta()).timeZone));
    if (!(await getMark(`day:${today}`))) {
      await enqueue("night", `fold:${today}:now:${at}`, { day: today, upto: at, keepFrom: 0 });
      await runJobsNow();
      if ((Number(await getMark(`day:${today}:upto`)) || 0) >= at) done.push("今天到现在");
    }
  }
  return { ok: true as const, done, pendingDay: await nextNightDay(now()) };
});

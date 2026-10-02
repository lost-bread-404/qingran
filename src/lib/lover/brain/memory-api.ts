import { createServerFn } from "@tanstack/react-start";
import { now } from "./clock.ts";
import { insertManualEdit } from "./life-store.ts";
import { deleteMemory, listMemories, memoryCounts, updateMemory } from "./memory.ts";

/** Settings → 他的心: every moment he keeps, newest first. */
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

/** 「现在整理」: the oldest day not yet in his memory (another one too, if the first was quick). */
export const brainRunNightNow = createServerFn({ method: "POST" }).handler(async () => {
  const [{ enqueueMemoryWork, nextNightDay }, { runJobsNow }] = await Promise.all([import("./night.ts"), import("./jobs.ts")]);
  const started = Date.now();
  const done: string[] = [];
  while (Date.now() - started < 30_000) {
    const day = await enqueueMemoryWork(now());
    if (!day || done.includes(day)) break;
    await runJobsNow();
    done.push(day);
  }
  return { ok: true as const, done, pendingDay: await nextNightDay(now()) };
});

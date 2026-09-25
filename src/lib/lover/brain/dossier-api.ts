import { createServerFn } from "@tanstack/react-start";
import { runJobsNow } from "./jobs.ts";
import { LONG_DRAIN_MS } from "./config.ts";
import { runInBackground } from "./wait-until.ts";
import {
  enqueueDossierActivate,
  enqueueEditorNow,
  getDossier,
  listDossierVersions,
  rollbackDossier,
  saveDossierBody,
} from "./dossier.ts";
import { listInnerLogs } from "./store.ts";
import { getInner } from "./store.ts";

export const brainGetDossier = createServerFn({ method: "GET" }).handler(async () => {
  if (await enqueueDossierActivate()) {
    await runInBackground(() => runJobsNow(LONG_DRAIN_MS));
  }
  const [row, versions] = await Promise.all([getDossier(), listDossierVersions(40)]);
  return { row, versions };
});

export const brainSaveDossier = createServerFn({ method: "POST" })
  .validator((input: { body: string }) => input)
  .handler(async ({ data }) => {
    const row = await saveDossierBody(String(data.body ?? "").slice(0, 20_000), "rosie");
    return { ok: true as const, row };
  });

export const brainRollbackDossier = createServerFn({ method: "POST" })
  .validator((input: { id: number }) => input)
  .handler(async ({ data }) => {
    const row = await rollbackDossier(Number(data.id));
    return { ok: true as const, row };
  });

export const brainEditDossierNow = createServerFn({ method: "POST" }).handler(async () => {
  await enqueueEditorNow();
  await runJobsNow();
  const [row, versions] = await Promise.all([getDossier(), listDossierVersions(40)]);
  return { ok: true as const, row, versions };
});

export const brainGetInnerNow = createServerFn({ method: "GET" }).handler(async () => {
  const { recentModeLog } = await import("./mode.ts");
  const [inner, log, modes] = await Promise.all([getInner(), listInnerLogs(20), recentModeLog(20)]);
  return { inner, log, modes };
});

/** 清然's notes about each day, newest day first. Last 30 days. */
export const brainGetDays = createServerFn({ method: "GET" }).handler(async () => {
  const [{ dayNotes, groupByDay }, { getMeta }, { resolveTz }] = await Promise.all([
    import("./day-notes.ts"),
    import("./store.ts"),
    import("./tz.ts"),
  ]);
  const tz = resolveTz((await getMeta()).timeZone);
  const to = Date.now();
  return groupByDay(await dayNotes(to - 30 * 24 * 3_600_000, to + 1), tz).reverse();
});

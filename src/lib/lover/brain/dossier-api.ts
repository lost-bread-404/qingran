import { createServerFn } from "@tanstack/react-start";
import { runJobsNow } from "./jobs.ts";
import { getDossier, listDossierVersions, rollbackDossier, saveDossierBody } from "./dossier.ts";
import { sql } from "./store.ts";

export const brainGetDossier = createServerFn({ method: "GET" }).handler(async () => {
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

/** 「现在把今天整理进去」: the night pass for today, now (memory and today's timeline only). */
export const brainEditDossierNow = createServerFn({ method: "POST" }).handler(async () => {
  const { enqueueNightNow } = await import("./night.ts");
  await enqueueNightNow();
  await runJobsNow();
  const [row, versions] = await Promise.all([getDossier(), listDossierVersions(40)]);
  return { ok: true as const, row, versions };
});

/** Each day's timeline, newest first, last 30 days (日记页). */
export const brainGetDays = createServerFn({ method: "GET" }).handler(async () => {
  const db = await sql();
  const rows = await db.query<{ day: string; timeline: string }>(
    `select day, timeline from qr_days where timeline <> '' order by day desc limit 30`,
  );
  return rows.map((r) => ({ day: String(r.day), lines: String(r.timeline).split("\n").filter((line) => line.trim()) }));
});

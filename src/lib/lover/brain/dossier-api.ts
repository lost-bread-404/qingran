import { createServerFn } from "@tanstack/react-start";
import { runJobsNow } from "./jobs.ts";
import {
  enableDossier,
  enqueueEditorNow,
  getDossier,
  listDossierVersions,
  rollbackDossier,
  saveDossierBody,
  seedDossierDraft,
} from "./dossier.ts";
import { listInnerLogs } from "./store.ts";
import { getInner } from "./store.ts";

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

export const brainEnableDossier = createServerFn({ method: "POST" })
  .validator((input: { body: string }) => input)
  .handler(async ({ data }) => {
    const row = await enableDossier(String(data.body ?? "").slice(0, 20_000));
    return { ok: true as const, row };
  });

export const brainRollbackDossier = createServerFn({ method: "POST" })
  .validator((input: { id: number }) => input)
  .handler(async ({ data }) => {
    const row = await rollbackDossier(Number(data.id));
    return { ok: true as const, row };
  });

export const brainSeedDossier = createServerFn({ method: "POST" }).handler(async () => {
  const draft = await seedDossierDraft();
  return { ok: true as const, draft };
});

export const brainEditDossierNow = createServerFn({ method: "POST" }).handler(async () => {
  await enqueueEditorNow();
  await runJobsNow();
  const [row, versions] = await Promise.all([getDossier(), listDossierVersions(40)]);
  return { ok: true as const, row, versions };
});

export const brainGetInnerNow = createServerFn({ method: "GET" }).handler(async () => {
  const [inner, log] = await Promise.all([getInner(), listInnerLogs(20)]);
  return { inner, log };
});

import { createServerFn } from "@tanstack/react-start";
import { enqueue, runJobsNow } from "./jobs.ts";
import {
  bumpNotesVersion,
  getDay,
  getMeta,
  getMind,
  getNote,
  getReport,
  getTheme,
  listActiveNotes,
  listBrainLog,
  listDays,
  listEpisodes,
  listExperiments,
  listFactors,
  listFindings,
  listIntentions,
  listNotes,
  listPortrait,
  listReports,
  listThemes,
  listThemeWeeks,
  messagesOnDay,
  notesForDay,
  notesForTheme,
  patchMeta,
  resetMind,
  setFactorFeedback,
  setFindingFeedback,
  setThemeFeedback,
  upsertNote,
  upsertPortrait,
} from "./store.ts";
import type { JobType, Lens, Note, Subject } from "./types.ts";
import { askDiary } from "./diary/ask.ts";
import { evaluateIfDue, startExperiment } from "./diary/experiments.ts";
import { buildReportData } from "./diary/report.ts";
import { safetyFlag } from "./diary/stats.ts";
import { localDay, shiftDay } from "./time.ts";
import { newId } from "../storage.ts";

export const brainGetOverview = createServerFn({ method: "GET" }).handler(async () => {
  const tz = (await getMeta()).timeZone || "UTC";
  const today = localDay(Date.now(), tz);
  const from = shiftDay(today, -90);
  const [days, episodes, findings, factors, meta] = await Promise.all([
    listDays(from, today),
    listEpisodes(),
    listFindings(),
    listFactors(true),
    getMeta(),
  ]);
  const low = factors.find((f) => f.name === "情绪低落");
  const flag = safetyFlag(
    episodes.filter((e) => e.factorId === (low?.id ?? "seed-情绪低落")),
    today,
  );
  return { days, episodes, findings, factors, safety_flag: flag, meta };
});

export const brainGetDay = createServerFn({ method: "POST" })
  .validator((input: { day: string }) => input)
  .handler(async ({ data }) => {
    const [log, notes, messages] = await Promise.all([
      getDay(data.day),
      notesForDay(data.day, false),
      messagesOnDay(data.day),
    ]);
    return { log, notes, messages };
  });

export const brainGetReports = createServerFn({ method: "GET" }).handler(async () => listReports());

export const brainGetReport = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => getReport(data.id));

export const brainGetThemes = createServerFn({ method: "GET" }).handler(async () => listThemes(false));

export const brainGetTheme = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const [theme, notes, weeks] = await Promise.all([
      getTheme(data.id),
      notesForTheme(data.id),
      listThemeWeeks(),
    ]);
    return { theme, notes, weeks: weeks.filter((w) => w.themeId === data.id) };
  });

export const brainGetIntentions = createServerFn({ method: "GET" }).handler(async () => listIntentions());

export const brainGetExperiments = createServerFn({ method: "GET" }).handler(async () => {
  await evaluateIfDue(localDay(Date.now(), (await getMeta()).timeZone || "UTC"));
  return listExperiments();
});

export const brainStartExperiment = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => startExperiment(data.id));

export const brainAskDiary = createServerFn({ method: "POST" })
  .validator((input: { question: string }) => input)
  .handler(async ({ data }) => askDiary(data.question.slice(0, 500)));

export const brainRunJobs = createServerFn({ method: "POST" })
  .validator((input: { types: JobType[] }) => input)
  .handler(async ({ data }) => {
    const types = data.types.filter((t) =>
      ["dusk", "synth", "report", "archive", "backfill"].includes(t),
    );
    if (types.includes("dusk")) {
      const tz = (await getMeta()).timeZone || "UTC";
      const day = shiftDay(localDay(Date.now(), tz), 0);
      await enqueue("dusk", `dusk:${day}`, { day }, Date.now(), true);
    }
    if (types.includes("synth")) {
      const { currentIsoWeek } = await import("./time");
      const tz = (await getMeta()).timeZone || "UTC";
      const week = currentIsoWeek(Date.now(), tz);
      await enqueue("synth", `synth:${week}`, { week }, Date.now(), true);
    }
    if (types.includes("report")) {
      const { previousMonth, yearMonth, localDay: ld } = await import("./time");
      const tz = (await getMeta()).timeZone || "UTC";
      const month = yearMonth(shiftDay(ld(Date.now(), tz), -1));
      await enqueue("report", `report:${month}`, { month }, Date.now(), true);
    }
    const ran = await runJobsNow(types);
    return { ok: true as const, ran };
  });

export const brainSetFeedback = createServerFn({ method: "POST" })
  .validator((input: { kind: "finding" | "theme" | "factor"; id: string; feedback: string | null }) => input)
  .handler(async ({ data }) => {
    if (data.kind === "finding") await setFindingFeedback(data.id, data.feedback);
    else if (data.kind === "theme") await setThemeFeedback(data.id, data.feedback);
    else await setFactorFeedback(data.id, data.feedback);
    return { ok: true as const };
  });

export const brainListNotes = createServerFn({ method: "POST" })
  .validator((input: { q?: string; subject?: Subject; tag?: string }) => input)
  .handler(async ({ data }) => listNotes({ q: data.q, subject: data.subject, tag: data.tag, limit: 200 }));

export const brainSaveNote = createServerFn({ method: "POST" })
  .validator(
    (input: {
      id?: string;
      text: string;
      tags?: string[];
      subject?: Subject;
      lens?: Lens[];
      happenedAt?: number;
      archive?: boolean;
    }) => input,
  )
  .handler(async ({ data }) => {
    const now = Date.now();
    const tz = (await getMeta()).timeZone || "UTC";
    const existing = data.id ? await getNote(data.id) : null;
    const note: Note = {
      id: existing?.id || `n:${newId()}`,
      text: data.text.slice(0, 120),
      tags: (data.tags ?? existing?.tags ?? []).slice(0, 6),
      subject: data.subject ?? existing?.subject ?? "us",
      lens: data.lens ?? existing?.lens ?? ["bond", "diary"],
      fromRosie: existing?.fromRosie ?? true,
      weight: existing?.weight ?? 4,
      status: data.archive ? "archived" : "active",
      supersededBy: existing?.supersededBy ?? null,
      links: existing?.links ?? [],
      happenedAt: data.happenedAt ?? existing?.happenedAt ?? now,
      localDay: existing?.localDay || localDay(data.happenedAt ?? now, tz),
      sourceIds: existing?.sourceIds ?? [],
      recallCount: existing?.recallCount ?? 0,
      lastRecalledAt: existing?.lastRecalledAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await upsertNote(note, undefined, existing ? "MANUAL_EDIT" : "ADD");
    await bumpNotesVersion();
    return { ok: true as const, note };
  });

export const brainGetLongLayer = createServerFn({ method: "GET" }).handler(async () => {
  const [portrait, meta, mind, log] = await Promise.all([
    listPortrait(),
    getMeta(),
    getMind(),
    listBrainLog(50),
  ]);
  return { portrait, self: meta.selfSummary, bond: meta.bondSummary, mind, log };
});

export const brainSaveLongLayer = createServerFn({ method: "POST" })
  .validator(
    (input: {
      self?: string;
      bond?: string;
      portrait?: Array<{ id: string; topic: string; body: string }>;
    }) => input,
  )
  .handler(async ({ data }) => {
    if (data.self != null || data.bond != null) {
      await patchMeta({
        ...(data.self != null ? { selfSummary: data.self.slice(0, 300) } : {}),
        ...(data.bond != null ? { bondSummary: data.bond.slice(0, 200) } : {}),
      });
    }
    if (data.portrait) {
      const now = Date.now();
      for (const p of data.portrait) {
        await upsertPortrait({
          id: p.id,
          topic: p.topic.slice(0, 40),
          body: p.body.slice(0, 80),
          status: "active",
          evidenceIds: [],
          lastSeen: now,
          updatedAt: now,
        });
      }
    }
    return { ok: true as const };
  });

export const brainResetMind = createServerFn({ method: "POST" }).handler(async () => {
  await resetMind();
  return { ok: true as const };
});

export const brainActiveNotes = createServerFn({ method: "GET" }).handler(async () => listActiveNotes());

export { buildReportData };

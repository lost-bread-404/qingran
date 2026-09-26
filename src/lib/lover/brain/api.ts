import { createServerFn } from "@tanstack/react-start";
import { now } from "./clock.ts";
import { enqueue, runJobsNow } from "./jobs.ts";
import { LONG_DRAIN_MS, listVoiceCatalog } from "./config.ts";
import { runInBackground } from "./wait-until.ts";
import { appendBrainLog, getMeta, listBrainLog, listJobStatus, listReports, voiceModelStatsLast7d } from "./store.ts";
import type { JobType } from "./types.ts";
import { resolveTz } from "./tz.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

export const brainGetReports = createServerFn({ method: "GET" }).handler(async () => listReports());

export const brainRunJobs = createServerFn({ method: "POST" })
  .validator((input: { types: JobType[] }) => input)
  .handler(async ({ data }) => {
    const types = data.types.filter((t) => t === "report");
    const ts = now();
    if (types.includes("report")) {
      const { yearMonth, localDay: ld } = await import("./time");
      const tz = resolveTz((await getMeta()).timeZone);
      const month = yearMonth(ld(ts, tz));
      await enqueue("report", `report-manual:${month}:${ts}`, { month }, ts, true);
    }
    await runInBackground(() => runJobsNow(LONG_DRAIN_MS));
    return { ok: true as const, started: true as const };
  });

export const brainGetDiary = createServerFn({ method: "GET" }).handler(async () => {
  const { getProfileData } = await import("./store");
  const { lockedProfile } = await import("../types");
  return { enabled: lockedProfile(await getProfileData()).diaryEnabled };
});

export const brainSetDiary = createServerFn({ method: "POST" })
  .validator((input: { enabled: boolean }) => ({ enabled: input.enabled === true }))
  .handler(async ({ data }) => {
    const { applyProfilePatch } = await import("../profile-patch.ts");
    await applyProfilePatch({ patch: { diaryEnabled: data.enabled }, source: "diary" });
    return { enabled: data.enabled };
  });

/** 日记页打开时：到期的月报排上，drain 放到后台，请求立刻返回。 */
export const brainRunDue = createServerFn({ method: "POST" })
  .validator((input: { timeZone?: string }) => input ?? {})
  .handler(async ({ data }) => {
    const tz = resolveTz(data?.timeZone || (await getMeta()).timeZone);
    const { enqueueReportIfDue } = await import("./diary/report");
    await enqueueReportIfDue(now(), tz);
    await runInBackground(() => runJobsNow(LONG_DRAIN_MS));
    return { ok: true as const, started: true as const };
  });

export const brainJobStatus = createServerFn({ method: "GET" }).handler(async () => listJobStatus());

export const brainListVoiceModels = createServerFn({ method: "GET" }).handler(async () => {
  const [models, stats] = await Promise.all([
    listVoiceCatalog(process.env.XAI_API_KEY),
    voiceModelStatsLast7d().catch(() => []),
  ]);
  const byModel = new Map(stats.map((row) => [row.model, row]));
  return {
    models: models.map((model) => ({
      id: model.id,
      blurb: model.blurb,
      supportsEffort: model.supportsEffort,
      stats: byModel.get(model.id) ?? null,
    })),
    stats,
  };
});

export const brainListLogs = createServerFn({ method: "POST" })
  .validator(
    (input: { limit?: number; route?: string | null; from?: number | null; to?: number | null }) => input,
  )
  .handler(async ({ data }) => {
    return listBrainLog(Math.min(Math.max(data.limit ?? 200, 1), 500), {
      route: data.route ?? null,
      from: data.from ?? null,
      to: data.to ?? null,
    });
  });

export const brainNoteCallStuck = createServerFn({ method: "POST" })
  .validator((input: { phase: string; deaf?: boolean }) => input)
  .handler(async ({ data }) => {
    const phase = String(data.phase || "unknown").slice(0, 40);
    const note = `状态卡住已恢复 phase=${phase}${data.deaf ? " deaf" : ""}`;
    await appendBrainLog({
      step: "call:stuck",
      ok: true,
      note,
      route: "voice",
      raw: note,
    });
    return { ok: true as const };
  });

export const brainGetTurnTrace = createServerFn({ method: "POST" })
  .validator((input: { turnSeq: number }) => input)
  .handler(async ({ data }) => {
    const { getSql } = await import("../../db.ts");
    const db = await getSql();
    const turns = await db.query<Record<string, unknown>>(
      "select * from brain_turns where turn_seq = $1",
      [data.turnSeq],
    );
    const logs = await db.query<Record<string, unknown>>(
      "select * from brain_log where turn_seq = $1 order by id",
      [data.turnSeq],
    );
    return { turn: asJson(turns[0] ?? null), logs: asJson(logs) };
  });

export const brainGetCallLog = createServerFn({ method: "POST" })
  .validator((input: { id: number }) => input)
  .handler(async ({ data }) => {
    const { getSql } = await import("../../db.ts");
    const { messagesFromStored } = await import("../call-log-view.ts");
    const db = await getSql();
    const rows = await db.query<Record<string, unknown>>("select * from brain_log where id = $1", [data.id]);
    const row = asJson(rows[0] ?? null) as Record<string, unknown> | null;
    if (!row) return null;
    const rawRows = await db.query<{ input: unknown }>("select input from brain_log_raw where log_id = $1", [data.id]);
    const storedMessages = messagesFromStored(rawRows[0]?.input);
    const fallbackMessages =
      storedMessages ??
      [
        row.input_system ? { role: "system", content: String(row.input_system) } : null,
        row.input_user ? { role: "user", content: String(row.input_user) } : null,
      ].filter((item): item is { role: string; content: string } => Boolean(item));
    const output = row.output_text ? String(row.output_text) : row.raw ? String(row.raw) : "";
    return {
      ...row,
      assembled: fallbackMessages,
      output,
      stored: Boolean(fallbackMessages.length),
      warnings: fallbackMessages.length ? [] : ["这一条没有存下发给模型的原文"],
    };
  });

export const brainGetDbSize = createServerFn({ method: "GET" }).handler(async () => {
  const { brainDbSize } = await import("./db-size.ts");
  return brainDbSize();
});

export const brainListPrompts = createServerFn({ method: "GET" }).handler(async () => {
  const { listPrompts } = await import("./prompts/store.ts");
  return listPrompts();
});

export const brainPreviewPrompt = createServerFn({ method: "POST" })
  .validator((input: { key: string; variantId?: string; body?: string }) => input)
  .handler(async ({ data }) => {
    const { previewPrompt } = await import("./prompts/preview.ts");
    return previewPrompt(data);
  });

export const brainRollbackPrompt = createServerFn({ method: "POST" })
  .validator((input: { key: string; hash: string }) => input)
  .handler(async ({ data }) => {
    const { isPromptKey } = await import("./prompts/catalog.ts");
    const { rollbackPrompt } = await import("./prompts/store.ts");
    if (!isPromptKey(data.key)) throw new Error("unknown-prompt");
    return rollbackPrompt(data.key, data.hash);
  });

export const brainSavePrompt = createServerFn({ method: "POST" })
  .validator((input: { key: string; body: string }) => input)
  .handler(async ({ data }) => {
    const { isPromptKey } = await import("./prompts/catalog.ts");
    const { savePrompt } = await import("./prompts/store.ts");
    if (!isPromptKey(data.key)) throw new Error("unknown-prompt");
    return savePrompt(data.key, data.body);
  });

export const brainRestorePrompt = createServerFn({ method: "POST" })
  .validator((input: { key: string }) => input)
  .handler(async ({ data }) => {
    const { isPromptKey } = await import("./prompts/catalog.ts");
    const { restorePrompt } = await import("./prompts/store.ts");
    if (!isPromptKey(data.key)) throw new Error("unknown-prompt");
    return restorePrompt(data.key);
  });


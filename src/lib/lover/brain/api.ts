import { createServerFn } from "@tanstack/react-start";
import { now } from "./clock.ts";
import { enqueue, runJobsNow } from "./jobs.ts";
import { LONG_DRAIN_MS, clampHistoryWindow, listVoiceCatalog } from "./config.ts";
import { runInBackground } from "./wait-until.ts";
import {
  bumpNotesVersion,
  getDay,
  getMeta,
  getInner,
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
  listNotesByIds,
  listPortrait,
  deletePortrait,
  setPortraitStatus,
  listReports,
  listThemes,
  listThemeWeeks,
  messagesOnDay,
  notesForDay,
  notesForTheme,
  patchMeta,
  resetInnerTurn,
  setFactorFeedback,
  setFindingFeedback,
  setThemeFeedback,
  upsertNote,
  upsertPortrait,
  listJobStatus,
  voiceModelStatsLast7d,
  appendBrainLog,
} from "./store.ts";
import type { JobType, Lens, Note, Subject } from "./types.ts";
import { isStorySeedPortrait } from "./portrait-kind.ts";
import { askDiary } from "./diary/ask.ts";
import { evaluateIfDue, startExperiment } from "./diary/experiments.ts";
import { safetyFlag } from "./diary/stats.ts";
import { localDay, shiftDay } from "./time.ts";
import { resolveTz } from "./tz.ts";
import { newId } from "../storage.ts";
import {
  convertV1,
  exportBackupPage,
  finishImport,
  importTableChunk,
  saveProfile,
  type BackupCursor,
  type BackupRow,
  type Json,
  type V1Backup,
} from "./backup.ts";
import type { Profile } from "../types.ts";

export const brainGetOverview = createServerFn({ method: "GET" }).handler(async () => {
  const tz = resolveTz((await getMeta()).timeZone);
  const today = localDay(now(), tz);
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
  await evaluateIfDue(localDay(now(), resolveTz((await getMeta()).timeZone)));
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

/** Diary 页面打开时调用：把到期的日/周/月任务排上，drain 放到后台，请求立刻返回。 */
export const brainRunDue = createServerFn({ method: "POST" })
  .validator((input: { timeZone?: string }) => input ?? {})
  .handler(async ({ data }) => {
    const tz = resolveTz(data?.timeZone || (await getMeta()).timeZone);
    const { enqueuePeriodicIfDue } = await import("./diary/dusk");
    await enqueuePeriodicIfDue(now(), tz);
    await runInBackground(() => runJobsNow(LONG_DRAIN_MS));
    return { ok: true as const, started: true as const };
  });

export const brainJobStatus = createServerFn({ method: "GET" }).handler(async () => listJobStatus());

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
    const ts = now();
    const tz = resolveTz((await getMeta()).timeZone);
    const existing = data.id ? await getNote(data.id) : null;
    const note: Note = {
      id: existing?.id || `n:${newId()}`,
      text: data.text.slice(0, 120),
      tags: (data.tags ?? existing?.tags ?? []).slice(0, 6),
      aliases: existing?.aliases ?? [],
      subject: data.subject ?? existing?.subject ?? "us",
      lens: data.lens ?? existing?.lens ?? ["bond", "diary"],
      fromRosie: existing?.fromRosie ?? true,
      weight: existing?.weight ?? 4,
      status: data.archive ? "archived" : "active",
      supersededBy: existing?.supersededBy ?? null,
      links: existing?.links ?? [],
      happenedAt: data.happenedAt ?? existing?.happenedAt ?? ts,
      localDay: existing?.localDay || localDay(data.happenedAt ?? ts, tz),
      sourceIds: existing?.sourceIds ?? [],
      recallCount: existing?.recallCount ?? 0,
      lastRecalledAt: existing?.lastRecalledAt ?? null,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    await upsertNote(note, undefined, existing ? "MANUAL_EDIT" : "ADD");
    await bumpNotesVersion();
    return { ok: true as const, note };
  });

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

export const brainGetLongLayer = createServerFn({ method: "GET" }).handler(async () => {
  const { ensureMemoryHygiene } = await import("./memory-hygiene.ts");
  await ensureMemoryHygiene();
  const [portrait, meta, mind, log] = await Promise.all([
    listPortrait(),
    getMeta(),
    getInner(),
    listBrainLog(80),
  ]);
  const evidenceIds = [...new Set(portrait.flatMap((row) => row.evidenceIds))];
  const notes = await listNotesByIds(evidenceIds);
  const days = new Map(notes.map((note) => [note.id, note.localDay]));
  return {
    portrait: portrait.map((row) => {
      const known = row.evidenceIds.map((id) => days.get(id)).filter((day): day is string => Boolean(day)).sort();
      return {
        ...row,
        evidenceCount: row.evidenceIds.length,
        evidenceFrom: known[0] ?? null,
        evidenceTo: known.at(-1) ?? null,
        retireReason: null,
      };
    }),
    self: meta.selfSummary,
    bond: meta.bondSummary,
    mind,
    inner: mind,
    log,
  };
});

export const brainListHygieneNotes = createServerFn({ method: "GET" }).handler(async () => {
  const { listQingranSelfNotes } = await import("./memory-hygiene.ts");
  const rows = await listQingranSelfNotes();
  return rows.map((n) => ({
    id: n.id,
    text: n.text,
    subject: n.subject,
    localDay: n.localDay,
  }));
});

export const brainDeleteHygieneNotes = createServerFn({ method: "POST" })
  .validator((input: { ids: string[] }) => input)
  .handler(async ({ data }) => {
    const { deleteNotesByIds, listQingranSelfNotes } = await import("./memory-hygiene.ts");
    const allowed = new Set((await listQingranSelfNotes()).map((n) => n.id));
    const ids = data.ids.filter((id) => allowed.has(id));
    const n = await deleteNotesByIds(ids);
    return { ok: true as const, n };
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

export const brainSaveLongLayer = createServerFn({ method: "POST" })
  .validator((input: { self?: string; bond?: string }) => input)
  .handler(async ({ data }) => {
    if (data.self != null || data.bond != null) {
      await patchMeta({
        ...(data.self != null ? { selfSummary: data.self.slice(0, 300) } : {}),
        ...(data.bond != null ? { bondSummary: data.bond.slice(0, 200) } : {}),
      });
    }
    return { ok: true as const };
  });

export const brainSetPortraitStatus = createServerFn({ method: "POST" })
  .validator((input: { id: string; status: "stale" | "active" | "superseded" }) => input)
  .handler(async ({ data }) => {
    const rows = await listPortrait();
    const cur = rows.find((row) => row.id === data.id);
    if (cur && isStorySeedPortrait(cur)) return { ok: false as const, error: "seed" as const };
    const status = data.status === "active" || data.status === "superseded" ? data.status : "stale";
    await setPortraitStatus(String(data.id), status);
    return { ok: true as const };
  });

export const brainSaveSeedPortrait = createServerFn({ method: "POST" })
  .validator((input: { id: string; topic: string; body: string }) => input)
  .handler(async ({ data }) => {
    const rows = await listPortrait();
    const cur = rows.find((row) => row.id === data.id);
    if (!cur || !isStorySeedPortrait(cur)) return { ok: false as const };
    const topic = data.topic.replace(/\s+/g, " ").trim().slice(0, 40);
    const body = data.body.replace(/\s+/g, " ").trim().slice(0, 2000);
    if (!topic || !body) return { ok: false as const };
    await upsertPortrait({
      ...cur,
      topic,
      body,
      kind: "seed",
      status: "active",
      updatedAt: now(),
    });
    return { ok: true as const };
  });

export const brainDeletePortrait = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    await deletePortrait(String(data.id));
    return { ok: true as const };
  });

export const brainResetMind = createServerFn({ method: "POST" }).handler(async () => {
  await resetInnerTurn();
  return { ok: true as const };
});

/** Re-check which messages have slid out of the voice window. Does not change reflector or portrait. */
export const brainSyncHistoryWindow = createServerFn({ method: "POST" })
  .validator((input: { historyWindow: number }) => input)
  .handler(async ({ data }) => {
    const { enqueueArchiveIfNeeded } = await import("./archivist.ts");
    await enqueueArchiveIfNeeded(now(), clampHistoryWindow(data.historyWindow));
    return { ok: true as const };
  });

export const brainActiveNotes = createServerFn({ method: "GET" }).handler(async () => listActiveNotes());

export const brainExportBackup = createServerFn({ method: "POST" })
  .validator((input: { cursor?: BackupCursor | null } | undefined) => input ?? {})
  .handler(async ({ data }) => exportBackupPage({ cursor: data?.cursor ?? null }));

export const brainImportChunk = createServerFn({ method: "POST" })
  .validator((input: { table: string; rows: BackupRow[]; importId?: string }) => input)
  .handler(async ({ data }) => importTableChunk(data.table, data.rows));

export const brainImportFinish = createServerFn({ method: "POST" })
  .validator((input: { importId?: string; v1?: boolean; profile?: Profile } | undefined) => input ?? {})
  .handler(async ({ data }) => {
    if (data?.profile) await saveProfile(data.profile);
    await finishImport({ v1: Boolean(data?.v1) });
    return { ok: true as const };
  });

/** v1 备份体积小，一次转完：用 brain_meta.timeZone 补 local_day / session_id。 */
export const brainImportV1 = createServerFn({ method: "POST" })
  .validator((input: { backup: V1Backup }) => input)
  .handler(async ({ data }) => {
    const raw = data.backup;
    if (!raw || raw.kind !== "qingran-backup" || raw.version !== 1) {
      return { inserted: 0, updated: 0, skipped: 0, error: "not-v1" as const };
    }
    const tz = resolveTz((await getMeta()).timeZone);
    const converted = convertV1(raw, tz);
    await saveProfile(converted.profile);
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const table of ["qingran_messages", "mem_notes"] as const) {
      const r = await importTableChunk(table, converted.tables[table]);
      inserted += r.inserted;
      updated += r.updated;
      skipped += r.skipped;
    }
    await finishImport({ v1: true });
    return { inserted, updated, skipped };
  });

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

export const brainGetDigests = createServerFn({ method: "GET" }).handler(async () => {
  const { getSql } = await import("../../db.ts");
  const db = await getSql();
  const rows = await db.query<{ day: string; markdown: string; data: unknown; updated_at: number }>(
    "select day, markdown, data, updated_at from brain_daily_digest order by day desc limit 90",
  );
  return rows.map((r) => ({
    day: r.day,
    markdown: r.markdown,
    data: asJson(r.data),
    updated_at: Number(r.updated_at),
  }));
});

export const brainGetDigest = createServerFn({ method: "POST" })
  .validator((input: { day: string }) => input)
  .handler(async ({ data }) => {
    const { getSql } = await import("../../db.ts");
    const db = await getSql();
    const rows = await db.query<{ day: string; markdown: string; data: unknown; updated_at: number }>(
      "select day, markdown, data, updated_at from brain_daily_digest where day = $1",
      [data.day],
    );
    const turns = await db.query<Record<string, unknown>>(
      "select turn_seq, user_msg_id, reply_msg_id, mind_stale, pack_ms, ttft_ms, total_ms, reply_chars, picked_ids, fallback_ids from brain_turns where local_day = $1 order by turn_seq",
      [data.day],
    );
    const logs = await db.query<Record<string, unknown>>(
      `select id, route, model, step, ok, ms, tokens_in, tokens_out, tokens_cached, tokens_reasoning, cost_usd, error, at
       from brain_log where route is not null
       order by at desc limit 200`,
    );
    const digest = rows[0]
      ? { day: rows[0].day, markdown: rows[0].markdown, data: asJson(rows[0].data), updated_at: Number(rows[0].updated_at) }
      : null;
    return { digest, turns: asJson(turns), logs: asJson(logs) };
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
    const mind = await db.query<Record<string, unknown>>(
      "select * from qr_mind_history where turn_seq = $1",
      [data.turnSeq],
    );
    const logs = await db.query<Record<string, unknown>>(
      "select * from brain_log where turn_seq = $1 order by id",
      [data.turnSeq],
    );
    return { turn: asJson(turns[0] ?? null), mind: asJson(mind[0] ?? null), logs: asJson(logs) };
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
    let rebuilt: { messages: Array<{ role: string; content: string }>; warnings: string[] } | null = null;
    if (!fallbackMessages.length) {
      rebuilt = await (await import("./rebuild.ts")).rebuildFromLog({
        id: Number(row.id),
        route: row.route ? String(row.route) : null,
        turn_seq: row.turn_seq == null ? null : Number(row.turn_seq),
      });
    }
    const output = row.output_text ? String(row.output_text) : row.raw ? String(row.raw) : "";
    const messages = fallbackMessages.length ? fallbackMessages : rebuilt?.messages ?? [];
    return {
      ...row,
      rebuilt: asJson(rebuilt),
      assembled: messages,
      output,
      stored: Boolean(fallbackMessages.length),
      warnings: rebuilt?.warnings ?? [],
    };
  });

export const brainRebuildPrompt = createServerFn({ method: "POST" })
  .validator((input: { turnSeq?: number; logId?: number; route?: string }) => input)
  .handler(async ({ data }) => {
    const { rebuildArchiveInput, rebuildReflectorInput, rebuildVoiceMessages } = await import("./rebuild.ts");
    if (data.route === "archive" && data.logId) return rebuildArchiveInput(data.logId);
    if (data.route === "reflect" && data.turnSeq != null) return rebuildReflectorInput(data.turnSeq);
    if (data.turnSeq != null) return rebuildVoiceMessages(data.turnSeq);
    return { messages: [], warnings: ["缺少参数"] };
  });

export const brainGetDbSize = createServerFn({ method: "GET" }).handler(async () => {
  const { brainDbSize } = await import("./db-size.ts");
  return brainDbSize();
});

export const brainExportLogs = createServerFn({ method: "POST" })
  .validator(
    (input: { from: number; to: number; table?: string; cursor?: string; rebuild?: boolean }) => input,
  )
  .handler(async ({ data }) => {
    const mod = await import("./observability.ts");
    const tables = ["brain_turns", "brain_log", "qr_mind_history", "mem_history", "brain_daily_digest", "brain_jobs"] as const;
    const table = tables.includes(data.table as (typeof tables)[number])
      ? (data.table as (typeof tables)[number])
      : undefined;
    const page = await mod.exportLogPage({
      from: data.from,
      to: data.to,
      table,
      cursor: data.cursor,
    });
    const rebuild = data.rebuild !== false;
    let rows = asJson(page.rows) as Record<string, unknown>[];
    if (rebuild && page.table === "brain_log") {
      const { rebuildFromLog } = await import("./rebuild.ts");
      rows = await Promise.all(
        rows.map(async (row) => {
          const rebuilt = await rebuildFromLog({
            id: Number(row.id),
            route: row.route ? String(row.route) : null,
            turn_seq: row.turn_seq == null ? null : Number(row.turn_seq),
          });
          return rebuilt ? { ...row, rebuilt } : row;
        }),
      );
    }
    return { table: page.table, rows: asJson(rows), next: page.next };
  });

export const brainListPrompts = createServerFn({ method: "GET" }).handler(async () => {
  const { listPrompts } = await import("./prompts/store.ts");
  return listPrompts();
});

export const brainPreviewVoiceSlots = createServerFn({ method: "GET" }).handler(async () => {
  const { loadVoicePerspective } = await import("./voice/pack.ts");
  return loadVoicePerspective();
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


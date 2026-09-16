import { enqueue } from "../jobs.ts";
import { callModel } from "../llm.ts";
import {
  addThemeMember,
  getFactorByName,
  listDayFactors,
  listDays,
  listFactors,
  listFindings,
  listNotes,
  listThemes,
  listThemeWeeks,
  notesForTheme,
  notesWithoutTheme,
  patchMeta,
  replaceEpisodes,
  themeMemberCounts,
  upsertDayFactor,
  upsertFactor,
  upsertFinding,
  upsertTheme,
  upsertThemeWeek,
} from "../store.ts";
import { daysInclusive, isoWeek, isoWeekStart, shiftDay } from "../time.ts";
import type { Factor, Theme } from "../types.ts";
import { DIARY_ANALYST_SYSTEM } from "./prompts.ts";
import {
  buildEpisodes,
  computeAllFindings,
  seriesFromDayFactors,
} from "./stats.ts";
import { newId } from "@/lib/lover/storage";
import { getMemoryIndex } from "../voice/retrieve.ts";
import { getNote } from "../store.ts";

const ASSIGN_SCHEMA = {
  name: "theme_assign",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["assignments"],
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["note_id", "theme_ids"],
          properties: {
            note_id: { type: "string" },
            theme_ids: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

const THEME_OPS_SCHEMA = {
  name: "theme_ops",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ops"],
    properties: {
      ops: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op", "id", "name", "definition", "from_id", "into_id", "children"],
          properties: {
            op: { type: "string", enum: ["CREATE", "REDEFINE", "MERGE", "SPLIT", "RETIRE"] },
            id: { type: "string" },
            name: { type: "string" },
            definition: { type: "string" },
            from_id: { type: "string" },
            into_id: { type: "string" },
            children: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "definition"],
                properties: { name: { type: "string" }, definition: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
};

const FACTOR_OPS_SCHEMA = {
  name: "factor_ops",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ops"],
    properties: {
      ops: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op", "id", "name", "definition", "is_outcome"],
          properties: {
            op: { type: "string", enum: ["CREATE", "REDEFINE", "RETIRE"] },
            id: { type: "string" },
            name: { type: "string" },
            definition: { type: "string" },
            is_outcome: { type: "boolean" },
          },
        },
      },
    },
  },
};

const ACTION_SCHEMA = {
  name: "theme_week_action",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["week", "action_taken"],
          properties: {
            week: { type: "string" },
            action_taken: { type: ["integer", "null"] },
          },
        },
      },
    },
  },
};

const VALUE_SCHEMA = {
  name: "factor_values",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["days"],
    properties: {
      days: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["day", "value", "evidence_ids"],
          properties: {
            day: { type: "string" },
            value: { type: ["integer", "null"] },
            evidence_ids: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

async function assignBatch(noteIds: string[], themes: Theme[], jobId?: string) {
  if (!noteIds.length || !themes.length) return;
  const notes = [];
  for (const id of noteIds) {
    const n = await getNote(id);
    if (n) notes.push(n);
  }
  if (!notes.length) return;
  const result = await callModel("assign", {
    system: DIARY_ANALYST_SYSTEM,
    input: `把笔记归入主题，可属于多个或都不属于。

【themes】
${themes.map((t) => `${t.id}|${t.name}|${t.definition}`).join("\n")}

【notes】
${notes.map((n) => `${n.id}|${n.localDay}|${n.text}`).join("\n")}`,
    schema: ASSIGN_SCHEMA,
    jobId,
  });
  const assignments = Array.isArray((result.json as { assignments?: unknown })?.assignments)
    ? ((result.json as { assignments: Array<{ note_id?: string; theme_ids?: string[] }> }).assignments ?? [])
    : [];
  const themeIds = new Set(themes.map((t) => t.id));
  for (const a of assignments) {
    const noteId = String(a.note_id ?? "");
    for (const tid of a.theme_ids ?? []) {
      if (!themeIds.has(tid)) continue;
      const theme = themes.find((t) => t.id === tid);
      if (theme) await addThemeMember(tid, noteId, theme.version);
    }
  }
}

export async function runSynth(week: string, jobId?: string): Promise<void> {
  const start = isoWeekStart(week);
  const end = shiftDay(start, 6);
  const weekNotes = await listNotes({
    fromDay: start,
    toDay: end,
    fromRosie: true,
    lens: "diary",
    status: "active",
    limit: 400,
  });
  let themes = await listThemes(true);
  const ids = weekNotes.map((n) => n.id);
  for (let i = 0; i < ids.length; i += 40) {
    await assignBatch(ids.slice(i, i + 40), themes, jobId);
  }

  const unassigned = await notesWithoutTheme(200);
  const counts = await themeMemberCounts();
  const weeks = await listThemeWeeks();
  const result = await callModel("synth", {
    system: DIARY_ANALYST_SYSTEM,
    input: `维护主题。CREATE 需要至少 3 条笔记支持。user_feedback=rejected 的不能重建。

【未归类笔记】
${unassigned.map((n) => `${n.id}|${n.localDay}|${n.text}`).join("\n").slice(0, 8000)}

【现有主题】
${themes
  .map((t) => {
    const recent = weeks
      .filter((w) => w.themeId === t.id)
      .sort((a, b) => b.week.localeCompare(a.week))
      .slice(0, 8)
      .map((w) => `${w.week}:${w.mentions}`)
      .join(",");
    return `${t.id}|${t.name}|${t.definition}|members=${counts[t.id] ?? 0}|feedback=${t.userFeedback ?? ""}|weeks=${recent}`;
  })
  .join("\n")}`,
    schema: THEME_OPS_SCHEMA,
    jobId,
  });

  const rejectedNames = new Set(
    (await listThemes(false)).filter((t) => t.userFeedback === "rejected").map((t) => t.name),
  );
  const ops = Array.isArray((result.json as { ops?: unknown })?.ops)
    ? ((result.json as { ops: Array<Record<string, unknown>> }).ops ?? [])
    : [];
  const changed: Theme[] = [];
  const now = Date.now();
  for (const op of ops) {
    const kind = String(op.op ?? "");
    if (kind === "CREATE") {
      const name = String(op.name ?? "").trim();
      const definition = String(op.definition ?? "").trim();
      if (!name || !definition || rejectedNames.has(name)) continue;
      const row: Theme = {
        id: `th:${newId()}`,
        name,
        definition,
        version: 1,
        status: "active",
        mergedInto: null,
        parentId: null,
        userFeedback: null,
        createdAt: now,
        updatedAt: now,
      };
      await upsertTheme(row);
      changed.push(row);
    } else if (kind === "REDEFINE") {
      const cur = themes.find((t) => t.id === String(op.id));
      if (!cur) continue;
      const next = { ...cur, definition: String(op.definition ?? cur.definition), version: cur.version + 1, updatedAt: now };
      await upsertTheme(next);
      changed.push(next);
    } else if (kind === "MERGE") {
      const from = themes.find((t) => t.id === String(op.from_id));
      const into = themes.find((t) => t.id === String(op.into_id));
      if (!from || !into) continue;
      await upsertTheme({ ...from, status: "merged", mergedInto: into.id, updatedAt: now });
    } else if (kind === "SPLIT") {
      const cur = themes.find((t) => t.id === String(op.id));
      if (!cur) continue;
      await upsertTheme({ ...cur, status: "retired", updatedAt: now });
      const children = Array.isArray(op.children) ? op.children : [];
      for (const ch of children) {
        const row: Theme = {
          id: `th:${newId()}`,
          name: String((ch as { name?: string }).name ?? ""),
          definition: String((ch as { definition?: string }).definition ?? ""),
          version: 1,
          status: "active",
          mergedInto: null,
          parentId: cur.id,
          userFeedback: null,
          createdAt: now,
          updatedAt: now,
        };
        if (!row.name) continue;
        await upsertTheme(row);
        changed.push(row);
      }
    } else if (kind === "RETIRE") {
      const cur = themes.find((t) => t.id === String(op.id));
      if (!cur) continue;
      await upsertTheme({ ...cur, status: "retired", updatedAt: now });
    }
  }

  themes = await listThemes(true);
  const diaryNotes = await listNotes({ fromRosie: true, lens: "diary", status: "active", limit: 2000 });
  for (const theme of changed) {
    const { mini } = await getMemoryIndex();
    const hits = mini.search(`${theme.name} ${theme.definition}`).slice(0, 80);
    const candidateIds = hits.map((h) => h.id);
    const extra = diaryNotes.slice(0, 40).map((n) => n.id);
    await assignBatch([...new Set([...candidateIds, ...extra])], [theme], jobId);
  }

  const start60 = shiftDay(end, -60);
  const days = await listDays(start60, end);
  for (const theme of themes) {
    const members = await notesForTheme(theme.id);
    const byWeek = new Map<string, number>();
    for (const n of members) {
      const w = isoWeek(n.localDay);
      byWeek.set(w, (byWeek.get(w) ?? 0) + 1);
    }
    const weekKeys = [...byWeek.keys()].sort().slice(-8);
    if (!weekKeys.length) continue;
    const judged = await callModel("assign", {
      system: DIARY_ANALYST_SYSTEM,
      input: `判断这些周是否对该主题有具体行动（day log 的 did/wins）。没有信息为 null。

主题：${theme.name} ${theme.definition}

【weeks】
${weekKeys.join(", ")}

【day logs】
${days
  .filter((d) => weekKeys.includes(isoWeek(d.day)))
  .map((d) => `${d.day}|did=${JSON.stringify(d.did)}|wins=${JSON.stringify(d.wins)}`)
  .join("\n")
  .slice(0, 6000)}`,
      schema: ACTION_SCHEMA,
      jobId,
    });
    const items = Array.isArray((judged.json as { items?: unknown })?.items)
      ? ((judged.json as { items: Array<{ week?: string; action_taken?: number | null }> }).items ?? [])
      : [];
    const actionMap = new Map(items.map((i) => [String(i.week), i.action_taken]));
    for (const w of weekKeys) {
      const weekDays = days.filter((d) => isoWeek(d.day) === w);
      const moods = weekDays.map((d) => d.mood).filter((m): m is number => m != null);
      const moodAvg = moods.length ? moods.reduce((a, b) => a + b, 0) / moods.length : null;
      const rawAction = actionMap.get(w);
      await upsertThemeWeek({
        themeId: theme.id,
        week: w,
        mentions: byWeek.get(w) ?? 0,
        actionTaken: rawAction === 1 ? 1 : rawAction === 0 ? 0 : null,
        moodAvg,
      });
    }
  }

  const factors = await listFactors(false);
  const findings = await listFindings();
  const recentDays = await listDays(shiftDay(end, -56), end);
  const factorResult = await callModel("synth", {
    system: DIARY_ANALYST_SYSTEM,
    input: `发现新的 factors。同一轮最多新增 5 个。rejected 的不能重建。

【day logs】
${recentDays
  .map((d) => `${d.day}|e=${d.energy}|m=${d.mood}|${d.summary}|wins=${JSON.stringify(d.wins)}|avoided=${JSON.stringify(d.avoided)}`)
  .join("\n")
  .slice(0, 8000)}

【factors】
${factors.map((f) => `${f.id}|${f.name}|${f.definition}|outcome=${f.isOutcome}|feedback=${f.userFeedback ?? ""}`).join("\n")}

【findings】
${findings.slice(0, 20).map((f) => `${f.kind}|${f.antecedentId}->${f.outcomeId}|lag=${f.lag}|lift=${f.lift}`).join("\n")}`,
    schema: FACTOR_OPS_SCHEMA,
    jobId,
  });
  const fops = Array.isArray((factorResult.json as { ops?: unknown })?.ops)
    ? ((factorResult.json as { ops: Array<Record<string, unknown>> }).ops ?? [])
    : [];
  const rejectedFactor = new Set(factors.filter((f) => f.userFeedback === "rejected").map((f) => f.name));
  let created = 0;
  const changedFactors: Factor[] = [];
  for (const op of fops) {
    const kind = String(op.op ?? "");
    if (kind === "CREATE") {
      if (created >= 5) continue;
      const name = String(op.name ?? "").trim();
      if (!name || rejectedFactor.has(name)) continue;
      if (await getFactorByName(name)) continue;
      const row: Factor = {
        id: `fa:${newId()}`,
        name,
        definition: String(op.definition ?? ""),
        version: 1,
        isOutcome: Boolean(op.is_outcome),
        status: "active",
        origin: "synth",
        userFeedback: null,
        createdAt: now,
        updatedAt: now,
      };
      await upsertFactor(row);
      changedFactors.push(row);
      created += 1;
    } else if (kind === "REDEFINE") {
      const cur = factors.find((f) => f.id === String(op.id));
      if (!cur) continue;
      const next = {
        ...cur,
        definition: String(op.definition ?? cur.definition),
        version: cur.version + 1,
        updatedAt: now,
      };
      await upsertFactor(next);
      changedFactors.push(next);
    } else if (kind === "RETIRE") {
      const cur = factors.find((f) => f.id === String(op.id));
      if (!cur) continue;
      await upsertFactor({ ...cur, status: "retired", updatedAt: now });
    }
  }
  for (const f of changedFactors) {
    await enqueue("backfill", `backfill:${f.id}:${f.version}`, { factorId: f.id });
  }

  await recomputeStats();
  await patchMeta({ lastSynthWeek: week });
}

export async function runBackfill(factorId: string, jobId?: string): Promise<void> {
  const factors = await listFactors(false);
  const factor = factors.find((f) => f.id === factorId);
  if (!factor) return;
  const allDays = await listDays("2000-01-01", "2100-01-01");
  for (let i = 0; i < allDays.length; i += 30) {
    const batch = allDays.slice(i, i + 30);
    const result = await callModel("backfill", {
      system: DIARY_ANALYST_SYSTEM,
      input: `按定义判定每天的 value（1/0/null）。

factor: ${factor.name}
definition: ${factor.definition}

【days】
${batch.map((d) => `${d.day}|${d.summary}|energy=${d.energy}|mood=${d.mood}|did=${JSON.stringify(d.did)}|wins=${JSON.stringify(d.wins)}|body=${d.body ?? ""}`).join("\n")}`,
      schema: VALUE_SCHEMA,
      jobId,
    });
    const rows = Array.isArray((result.json as { days?: unknown })?.days)
      ? ((result.json as { days: Array<{ day?: string; value?: unknown; evidence_ids?: string[] }> }).days ?? [])
      : [];
    for (const row of rows) {
      const day = String(row.day ?? "");
      if (!day) continue;
      const v = row.value;
      await upsertDayFactor({
        day,
        factorId: factor.id,
        version: factor.version,
        value: v === 1 || v === 0 ? v : null,
        evidenceIds: (row.evidence_ids ?? []).map(String),
      });
    }
  }
}

export async function recomputeStats(): Promise<void> {
  const factors = await listFactors(true);
  const dayFactors = await listDayFactors();
  const themeWeeks = await listThemeWeeks();
  const now = Date.now();
  const days = [...new Set(dayFactors.map((d) => d.day))].sort();
  const episodes = factors
    .filter((f) => f.isOutcome)
    .flatMap((f) => buildEpisodes(f.id, seriesFromDayFactors(dayFactors, f.id), days, now));
  await replaceEpisodes(episodes);
  const findings = computeAllFindings({
    factors,
    dayFactors,
    themeWeeks: themeWeeks.map((w) => ({ themeId: w.themeId, week: w.week, mentions: w.mentions })),
    now,
  });
  const existing = await listFindings();
  const rejected = new Set(existing.filter((f) => f.userFeedback === "rejected").map((f) => f.id));
  for (const f of findings) {
    if (rejected.has(f.id)) continue;
    const prev = existing.find((e) => e.id === f.id);
    await upsertFinding({ ...f, userFeedback: prev?.userFeedback ?? null });
  }
}

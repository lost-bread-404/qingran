import { enqueue } from "../jobs.ts";
import { now as wallClock } from "../clock.ts";
import { asModelInput, callModel } from "../llm.ts";
import {
  addThemeMember,
  getFactorByName,
  getNote,
  listDays,
  listFactors,
  listFindings,
  listNotes,
  listThemes,
  listThemeWeeks,
  notesForTheme,
  notesWithoutTheme,
  patchMeta,
  themeMemberCounts,
  upsertDayFactor,
  upsertFactor,
  upsertTheme,
  upsertThemeWeek,
  getMeta,
} from "../store.ts";
import { isoWeek, isoWeekStart, shiftDay } from "../time.ts";
import type { Factor, Theme } from "../types.ts";
import { loadPrompt } from "../prompts/store.ts";
import { parsePromptBody, renderVariant } from "../prompts/doc.ts";
import { recomputeStats } from "./recompute.ts";
import { newId } from "../../storage.ts";
import { getMemoryIndex } from "../voice/retrieve.ts";

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
  const assignPrompt = await loadPrompt("assign");
  const result = await callModel("assign", {
    ...asModelInput(
      renderVariant(parsePromptBody("assign", assignPrompt.body), "notes", {
        themes: themes.map((t) => `${t.id}|${t.name}|${t.definition}`).join("\n"),
        notes: notes.map((n) => `${n.id}|${n.localDay}|${n.text}`).join("\n"),
      }),
    ),
    schema: ASSIGN_SCHEMA,
    jobId,
    promptKey: assignPrompt.key,
    promptHash: assignPrompt.hash,
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

export async function runSynth(
  week: string,
  jobId?: string,
  opts: { manual?: boolean } = {},
): Promise<void> {
  if (!/^\d{4}-W\d{2}$/.test(week)) return;
  const start = isoWeekStart(week);
  const end = shiftDay(start, 6);
  const weekNotes = await listNotes({
    fromDay: start,
    toDay: end,
    fromRosie: true,
    lens: "diary",
    statuses: ["active", "superseded"],
    limit: 400,
  });
  const weekDays = await listDays(start, end);
  const hasCoverage = weekDays.some((d) => d.coverage !== "none");
  if (!opts.manual && weekNotes.length === 0 && !hasCoverage) {
    const meta = await getMeta();
    if (!meta.lastSynthWeek || meta.lastSynthWeek < week) await patchMeta({ lastSynthWeek: week });
    return;
  }
  let themes = await listThemes(true);
  const ids = weekNotes.map((n) => n.id);
  for (let i = 0; i < ids.length; i += 40) {
    await assignBatch(ids.slice(i, i + 40), themes, jobId);
  }

  const unassigned = await notesWithoutTheme(200);
  const counts = await themeMemberCounts();
  const weeks = await listThemeWeeks();
  const synthPrompt = await loadPrompt("synth");
  const result = await callModel("synth", {
    ...asModelInput(
      renderVariant(parsePromptBody("synth", synthPrompt.body), "themes", {
        themes: themes
          .map((t) => {
            const recent = weeks
              .filter((w) => w.themeId === t.id)
              .sort((a, b) => b.week.localeCompare(a.week))
              .slice(0, 8)
              .map((w) => `${w.week}:${w.mentions}`)
              .join(",");
            return `${t.id}|${t.name}|${t.definition}|members=${counts[t.id] ?? 0}|feedback=${t.userFeedback ?? ""}|weeks=${recent}`;
          })
          .join("\n"),
        notes: unassigned.map((n) => `${n.id}|${n.localDay}|${n.text}`).join("\n").slice(0, 8000),
      }),
    ),
    schema: THEME_OPS_SCHEMA,
    jobId,
    promptKey: synthPrompt.key,
    promptHash: synthPrompt.hash,
  });

  const rejectedNames = new Set(
    (await listThemes(false)).filter((t) => t.userFeedback === "rejected").map((t) => t.name),
  );
  const ops = Array.isArray((result.json as { ops?: unknown })?.ops)
    ? ((result.json as { ops: Array<Record<string, unknown>> }).ops ?? [])
    : [];
  const changed: Theme[] = [];
  const now = wallClock();
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
  const diaryNotes = await listNotes({ fromRosie: true, lens: "diary", statuses: ["active", "superseded"], limit: 2000 });
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
    const byId = new Map(members.map((n) => [n.id, n]));
    const byWeek = new Map<string, Set<string>>();
    for (const n of members) {
      if (n.status !== "active" && n.status !== "superseded") continue;
      const w = isoWeek(n.localDay);
      let cur = n;
      while (cur.supersededBy && byId.has(cur.supersededBy)) cur = byId.get(cur.supersededBy)!;
      const set = byWeek.get(w) ?? new Set();
      set.add(cur.id);
      byWeek.set(w, set);
    }
    const weekKeys = [...byWeek.keys()].sort().slice(-8);
    if (!weekKeys.length) continue;
    const assignWeek = await loadPrompt("assign");
    const judged = await callModel("assign", {
      ...asModelInput(
        renderVariant(parsePromptBody("assign", assignWeek.body), "weeks", {
          theme: `${theme.name} ${theme.definition}`,
          weeks: weekKeys.join(", "),
          day_logs: days
            .filter((d) => weekKeys.includes(isoWeek(d.day)))
            .map((d) => `${d.day}|did=${JSON.stringify(d.did)}|wins=${JSON.stringify(d.wins)}`)
            .join("\n")
            .slice(0, 6000),
        }),
      ),
      schema: ACTION_SCHEMA,
      jobId,
      promptKey: assignWeek.key,
      promptHash: assignWeek.hash,
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
        mentions: byWeek.get(w)?.size ?? 0,
        actionTaken: rawAction === 1 ? 1 : rawAction === 0 ? 0 : null,
        moodAvg,
      });
    }
  }

  const factors = await listFactors(false);
  const findings = await listFindings();
  const recentDays = await listDays(shiftDay(end, -56), end);
  const factorPrompt = await loadPrompt("synth");
  const factorResult = await callModel("synth", {
    ...asModelInput(
      renderVariant(parsePromptBody("synth", factorPrompt.body), "factors", {
        factors: factors
          .map((f) => `${f.id}|${f.name}|${f.definition}|outcome=${f.isOutcome}|feedback=${f.userFeedback ?? ""}`)
          .join("\n"),
        findings: findings
          .slice(0, 20)
          .map((f) => `${f.kind}|${f.antecedentId}->${f.outcomeId}|lag=${f.lag}|lift=${f.lift}`)
          .join("\n"),
        day_logs: recentDays
          .map(
            (d) =>
              `${d.day}|e=${d.energy}|m=${d.mood}|${d.summary}|wins=${JSON.stringify(d.wins)}|avoided=${JSON.stringify(d.avoided)}`,
          )
          .join("\n")
          .slice(0, 8000),
      }),
    ),
    schema: FACTOR_OPS_SCHEMA,
    jobId,
    promptKey: factorPrompt.key,
    promptHash: factorPrompt.hash,
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
  if (!opts.manual) {
    const meta = await getMeta();
    if (!meta.lastSynthWeek || meta.lastSynthWeek < week) await patchMeta({ lastSynthWeek: week });
  }
}

export async function runBackfill(factorId: string, jobId?: string): Promise<void> {
  const factors = await listFactors(false);
  const factor = factors.find((f) => f.id === factorId);
  if (!factor) return;
  const allDays = await listDays("2000-01-01", "2100-01-01");
  for (let i = 0; i < allDays.length; i += 30) {
    const batch = allDays.slice(i, i + 30);
    const backfillPrompt = await loadPrompt("backfill");
    const result = await callModel("backfill", {
      ...asModelInput(
        renderVariant(parsePromptBody("backfill", backfillPrompt.body), "main", {
          factor_name: factor.name,
          factor_definition: factor.definition,
          days: batch
            .map(
              (d) =>
                `${d.day}|${d.summary}|energy=${d.energy}|mood=${d.mood}|did=${JSON.stringify(d.did)}|wins=${JSON.stringify(d.wins)}|body=${d.body ?? ""}`,
            )
            .join("\n"),
        }),
      ),
      schema: VALUE_SCHEMA,
      jobId,
      promptKey: backfillPrompt.key,
      promptHash: backfillPrompt.hash,
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

export { recomputeStats } from "./recompute.ts";

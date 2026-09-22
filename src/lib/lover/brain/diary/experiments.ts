import { callModel } from "../llm.ts";
import { now as wallClock } from "../clock.ts";
import { listDayFactors, listExperiments, listFactors, upsertExperiment } from "../store.ts";
import { daysInclusive, shiftDay } from "../time.ts";
import type { Experiment } from "../types.ts";
import { newId } from "../../storage.ts";
import { loadPrompt } from "../prompts/store.ts";

const SCHEMA = {
  name: "experiments",
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
          required: ["hypothesis", "action", "outcome_id", "compliance_factor_id"],
          properties: {
            hypothesis: { type: "string" },
            action: { type: "string" },
            outcome_id: { type: "string" },
            compliance_factor_id: { type: "string" },
          },
        },
      },
    },
  },
};

export async function proposeExperiments(reportData: unknown, jobId?: string): Promise<void> {
  const existing = await listExperiments();
  if (existing.some((e) => e.status === "proposed" || e.status === "active")) return;
  const loaded = await loadPrompt("experiments");
  const result = await callModel("report", {
    system: loaded.body,
    input: JSON.stringify(reportData).slice(0, 12_000),
    schema: SCHEMA,
    jobId,
    promptKey: loaded.key,
    promptHash: loaded.hash,
  });
  const items = Array.isArray((result.json as { items?: unknown })?.items)
    ? ((result.json as { items: Array<Record<string, string>> }).items ?? [])
    : [];
  const now = wallClock();
  const start = new Date(now).toISOString().slice(0, 10);
  for (const item of items.slice(0, 3)) {
    const row: Experiment = {
      id: `ex:${newId()}`,
      hypothesis: String(item.hypothesis ?? "").slice(0, 200),
      action: String(item.action ?? "").slice(0, 200),
      outcomeId: String(item.outcome_id ?? ""),
      complianceFactorId: String(item.compliance_factor_id ?? "") || null,
      startDay: start,
      endDay: shiftDay(start, 14),
      status: "proposed",
      result: null,
      createdAt: now,
    };
    if (!row.hypothesis || !row.action || !row.outcomeId) continue;
    await upsertExperiment(row);
  }
}

export async function startExperiment(id: string): Promise<Experiment | null> {
  const all = await listExperiments();
  const cur = all.find((e) => e.id === id);
  if (!cur) return null;
  const start = new Date().toISOString().slice(0, 10);
  const next = { ...cur, status: "active" as const, startDay: start, endDay: shiftDay(start, 14) };
  await upsertExperiment(next);
  return next;
}

export async function evaluateIfDue(today: string): Promise<void> {
  const all = await listExperiments();
  const factors = await listFactors(true);
  void factors;
  const dayFactors = await listDayFactors();
  for (const ex of all) {
    if (ex.status !== "active") continue;
    if (ex.endDay > today) continue;
    const period = daysInclusive(ex.startDay, ex.endDay);
    const preStart = shiftDay(ex.startDay, -28);
    const preDays = daysInclusive(preStart, shiftDay(ex.startDay, -1));
    const oRows = dayFactors.filter((d) => d.factorId === ex.outcomeId);
    const cRows = ex.complianceFactorId
      ? dayFactors.filter((d) => d.factorId === ex.complianceFactorId)
      : [];
    const oMap = new Map(oRows.map((r) => [r.day, r.value]));
    const cMap = new Map(cRows.map((r) => [r.day, r.value]));
    const doneDays = period.filter((d) => cMap.get(d) === 1);
    const skipDays = period.filter((d) => cMap.get(d) === 0);
    const oRate = (days: string[]) => {
      const known = days.filter((d) => oMap.get(d) != null);
      if (!known.length) return null;
      return known.filter((d) => oMap.get(d) === 1).length / known.length;
    };
    const sample = period.filter((d) => oMap.get(d) != null).length;
    const result = {
      complianceDays: doneDays.length,
      skippedDays: skipDays.length,
      outcomeWhenDone: oRate(doneDays),
      outcomeWhenSkipped: oRate(skipDays),
      baseline28: oRate(preDays),
      insufficient: sample < 5,
    };
    await upsertExperiment({ ...ex, status: "done", result });
  }
}

import { enqueue } from "../jobs.ts";
import { callModel } from "../llm.ts";
import {
  getMeta,
  listFactors,
  messagesOnDay,
  notesForDay,
  openIntentions,
  patchMeta,
  upsertDay,
  upsertDayFactor,
  upsertIntention,
} from "../store.ts";
import { afterBoundary, localDay, overnightValue, shiftDay, yesterday } from "../time.ts";
import type { DayLog, Intention } from "../types.ts";
import { archiveDaySync } from "../archivist.ts";
import { updatePortraitSelfBond } from "../voice/nightly.ts";
import { DUSK_DAY_SYSTEM } from "./prompts.ts";
import { newId } from "@/lib/lover/storage";

const DAY_SCHEMA = {
  name: "day_log",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "energy",
      "mood",
      "body",
      "did",
      "avoided",
      "events",
      "wins",
      "intention_ops",
    ],
    properties: {
      summary: { type: "string" },
      energy: { type: ["integer", "null"] },
      mood: { type: ["integer", "null"] },
      body: { type: ["string", "null"] },
      did: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "intention_id"],
          properties: { text: { type: "string" }, intention_id: { type: "string" } },
        },
      },
      avoided: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: { text: { type: "string" } },
        },
      },
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: { text: { type: "string" } },
        },
      },
      wins: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: { text: { type: "string" } },
        },
      },
      intention_ops: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op", "id", "text", "tag", "target_day", "evidence_ids"],
          properties: {
            op: { type: "string", enum: ["ADD", "START", "DONE", "DROP", "TOUCH"] },
            id: { type: "string" },
            text: { type: "string" },
            tag: { type: "string" },
            target_day: { type: "string" },
            evidence_ids: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

const FACTOR_SCHEMA = {
  name: "day_factors",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["factors"],
    properties: {
      factors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "value", "evidence_ids"],
          properties: {
            id: { type: "string" },
            value: { type: ["integer", "null"] },
            evidence_ids: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

function coverageOf(msgCount: number, diaryNotes: number): DayLog["coverage"] {
  if (msgCount === 0) return "none";
  if (msgCount < 10 || diaryNotes < 2) return "thin";
  return "ok";
}

function ternary(v: unknown): -1 | 0 | 1 | null {
  if (v == null) return null;
  const n = Number(v);
  if (n === -1 || n === 0 || n === 1) return n;
  return null;
}

export async function runDusk(day: string, jobId?: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  await archiveDaySync(day, jobId);

  const messages = await messagesOnDay(day);
  const notes = await notesForDay(day, true);
  const first = messages[0]?.createdAt ?? null;
  const last = messages[messages.length - 1]?.createdAt ?? null;
  const cover = coverageOf(messages.length, notes.length);

  const intentions = await openIntentions();
  const rosieText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.text)
    .join("\n")
    .slice(0, 3000);

  const dayResult = await callModel("dusk", {
    system: DUSK_DAY_SYSTEM,
    input: `日期 ${day}

【日记笔记】
${notes.map((n) => `${n.id}|${n.text}`).join("\n") || "（没有）"}

【Rosie 的话】
${rosieText || "（没有）"}

【进行中的 intentions】
${intentions.map((i) => `${i.id}|${i.status}|${i.tag ?? ""}|${i.text}`).join("\n") || "（没有）"}`,
    schema: DAY_SCHEMA,
    jobId,
  });

  const parsed = (dayResult.json && typeof dayResult.json === "object" ? dayResult.json : {}) as Record<
    string,
    unknown
  >;
  const now = Date.now();
  const log: DayLog = {
    day,
    summary: String(parsed.summary ?? "").slice(0, 300),
    energy: ternary(parsed.energy),
    mood: ternary(parsed.mood),
    body: parsed.body == null || parsed.body === "" ? null : String(parsed.body).slice(0, 120),
    did: Array.isArray(parsed.did) ? (parsed.did as DayLog["did"]) : [],
    avoided: Array.isArray(parsed.avoided) ? (parsed.avoided as DayLog["avoided"]) : [],
    events: Array.isArray(parsed.events) ? (parsed.events as DayLog["events"]) : [],
    wins: Array.isArray(parsed.wins) ? (parsed.wins as DayLog["wins"]) : [],
    firstActive: first,
    lastActive: last,
    msgCount: messages.length,
    coverage: cover,
    noteIds: notes.map((n) => n.id),
    version: 1,
    updatedAt: now,
  };
  await upsertDay(log);

  const known = new Map(intentions.map((i) => [i.id, i]));
  const ops = Array.isArray(parsed.intention_ops)
    ? (parsed.intention_ops as Array<Record<string, unknown>>)
    : [];
  for (const op of ops) {
    const kind = String(op.op ?? "");
    const evidence = Array.isArray(op.evidence_ids) ? op.evidence_ids.map(String) : [];
    if (kind === "ADD") {
      const text = String(op.text ?? "").trim();
      if (!text) continue;
      const row: Intention = {
        id: newId(),
        text,
        tag: String(op.tag ?? "") || null,
        statedAt: now,
        targetDay: String(op.target_day ?? "") || null,
        status: "open",
        startedAt: null,
        doneAt: null,
        lastEvidenceAt: now,
        evidenceIds: evidence,
        updatedAt: now,
      };
      await upsertIntention(row);
      continue;
    }
    const id = String(op.id ?? "");
    const cur = known.get(id);
    if (!cur) continue;
    const next = { ...cur, evidenceIds: [...cur.evidenceIds, ...evidence], lastEvidenceAt: now, updatedAt: now };
    if (kind === "START") {
      next.status = "started";
      next.startedAt = next.startedAt ?? now;
    } else if (kind === "DONE") {
      next.status = "done";
      next.doneAt = now;
      if (!next.startedAt) next.startedAt = now;
    } else if (kind === "DROP") {
      next.status = "dropped";
    }
    await upsertIntention(next);
  }

  const factors = await listFactors(true);
  const factorResult = await callModel("dusk", {
    system: DUSK_DAY_SYSTEM,
    input: `根据这一天的 day log 和笔记，判定每个 factor 的 value：1、0 或 null（未知）。不要猜。

【day log】
${JSON.stringify({ summary: log.summary, energy: log.energy, mood: log.mood, body: log.body, did: log.did, avoided: log.avoided, events: log.events, wins: log.wins })}

【笔记】
${notes.map((n) => n.text).join("\n")}

【factors】
${factors.map((f) => `${f.id}|${f.name}|${f.definition}`).join("\n")}`,
    schema: FACTOR_SCHEMA,
    jobId,
  });
  const judged = Array.isArray((factorResult.json as { factors?: unknown })?.factors)
    ? ((factorResult.json as { factors: Array<{ id?: string; value?: unknown; evidence_ids?: string[] }> }).factors ?? [])
    : [];
  const judgedMap = new Map(judged.map((j) => [String(j.id), j]));

  for (const f of factors) {
    let value: 1 | 0 | null = null;
    if (f.name === "熬夜") {
      value = overnightValue(last, (await getMeta()).timeZone || "UTC");
    }
    if (value == null) {
      const j = judgedMap.get(f.id);
      const v = j?.value;
      if (v === 1 || v === 0) value = v;
      else if (v === null) value = null;
    }
    await upsertDayFactor({
      day,
      factorId: f.id,
      version: f.version,
      value,
      evidenceIds: judgedMap.get(f.id)?.evidence_ids?.map(String) ?? [],
    });
  }

  await updatePortraitSelfBond(day, jobId);
  await patchMeta({ lastDuskDay: day });
}

export async function enqueuePeriodicIfDue(nowMs: number, timeZone: string): Promise<void> {
  const meta = await getMeta();
  if (meta.timeZone !== timeZone) await patchMeta({ timeZone });
  if (!afterBoundary(nowMs, timeZone)) return;

  const yest = yesterday(nowMs, timeZone);
  let last = meta.lastDuskDay || shiftDay(yest, -14);
  let guard = 0;
  while (last < yest && guard < 14) {
    last = shiftDay(last, 1);
    await enqueue("dusk", `dusk:${last}`, { day: last });
    guard += 1;
  }

  const { currentIsoWeek, previousMonth } = await import("../time");
  const week = currentIsoWeek(nowMs, timeZone);
  if (meta.lastSynthWeek < week) {
    await enqueue("synth", `synth:${week}`, { week });
  }
  const month = previousMonth(nowMs, timeZone);
  const today = localDay(nowMs, timeZone);
  if (today.slice(8) >= "01" && meta.lastReportMonth < month) {
    await enqueue("report", `report:${month}`, { month });
  }
}

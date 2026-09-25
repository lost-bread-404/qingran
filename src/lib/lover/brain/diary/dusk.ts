import { enqueue } from "../jobs.ts";
import { now } from "../clock.ts";
import { callModel, asModelInput } from "../llm.ts";
import {
  getMeta,
  listFactors,
  messagesOnDay,
  notesForDay,
  openIntentions,
  patchMeta,
  upsertDay,
  upsertDayFactor,
} from "../store.ts";
import { localDay, overnightValue, previousMonth } from "../time.ts";
import { resolveTz } from "../tz.ts";
import type { DayLog } from "../types.ts";
import { archiveDaySync } from "../archivist.ts";
import { loadPrompt } from "../prompts/store.ts";
import { parsePromptBody, renderVariant } from "../prompts/doc.ts";
import { applyIntentionOps, type IntentionOp } from "./intentions.ts";
import { recomputeStats } from "./recompute.ts";
import { writeDailyDigest } from "./digest.ts";
import { getCoreIndexItems } from "../voice/retrieve.ts";

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

async function warmupCoreIndex(): Promise<void> {
  const meta = await getMeta();
  const today = localDay(now(), resolveTz(meta.timeZone));
  await getCoreIndexItems(today);
}

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

async function writeEmptyDay(day: string, notes: { id: string }[]): Promise<void> {
  const ts = now();
  const log: DayLog = {
    day,
    summary: "",
    energy: null,
    mood: null,
    body: null,
    did: [],
    avoided: [],
    events: [],
    wins: [],
    firstActive: null,
    lastActive: null,
    msgCount: 0,
    coverage: "none",
    noteIds: notes.map((n) => n.id),
    version: 1,
    updatedAt: ts,
  };
  await upsertDay(log);
  const factors = await listFactors(true);
  for (const f of factors) {
    await upsertDayFactor({
      day,
      factorId: f.id,
      version: f.version,
      value: null,
      evidenceIds: [],
    });
  }
}

export async function runDusk(
  day: string,
  jobId?: string,
  opts: { manual?: boolean } = {},
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  await archiveDaySync(day, jobId);

  const messages = await messagesOnDay(day);
  const notes = await notesForDay(day, true);
  const empty = messages.length === 0 && notes.length === 0;

  if (empty && !opts.manual) {
    await writeEmptyDay(day, notes);
    await recomputeStats();
    await writeDailyDigest(day);
    await warmupCoreIndex();
    const meta = await getMeta();
    if (!meta.lastDuskDay || meta.lastDuskDay < day) await patchMeta({ lastDuskDay: day });
    return;
  }

  const first = messages[0]?.createdAt ?? null;
  const last = messages[messages.length - 1]?.createdAt ?? null;
  const cover = coverageOf(messages.length, notes.length);

  const intentions = await openIntentions();
  const rosieText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.text)
    .join("\n")
    .slice(0, 3000);

  const duskPrompt = await loadPrompt("dusk");
  const dayResult = await callModel("dusk", {
    ...asModelInput(
      renderVariant(parsePromptBody("dusk", duskPrompt.body), "day", {
        intentions: intentions.map((i) => `${i.id}|${i.status}|${i.tag ?? ""}|${i.text}`).join("\n") || "（没有）",
        notes: notes.map((n) => `${n.id}|${n.text}`).join("\n") || "（没有）",
        rosie_text: rosieText || "（没有）",
        day,
      }),
    ),
    schema: DAY_SCHEMA,
    jobId,
    promptKey: duskPrompt.key,
    promptHash: duskPrompt.hash,
  });

  const parsed = (dayResult.json && typeof dayResult.json === "object" ? dayResult.json : {}) as Record<
    string,
    unknown
  >;
  const ts = now();
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
    updatedAt: ts,
  };
  await upsertDay(log);

  const ops = Array.isArray(parsed.intention_ops)
    ? (parsed.intention_ops as IntentionOp[])
    : [];
  await applyIntentionOps(day, ops, ts);

  const factors = await listFactors(true);
  const factorResult = await callModel("dusk", {
    ...asModelInput(
      renderVariant(parsePromptBody("dusk", duskPrompt.body), "factors", {
        factors: factors.map((f) => `${f.id}|${f.name}|${f.definition}`).join("\n"),
        day_log: JSON.stringify({
          day,
          summary: log.summary,
          energy: log.energy,
          mood: log.mood,
          body: log.body,
          did: log.did,
          avoided: log.avoided,
          events: log.events,
          wins: log.wins,
        }),
        notes: notes.map((n) => n.text).join("\n"),
        day,
      }),
    ),
    schema: FACTOR_SCHEMA,
    jobId,
    promptKey: duskPrompt.key,
    promptHash: duskPrompt.hash,
  });
  const judged = Array.isArray((factorResult.json as { factors?: unknown })?.factors)
    ? ((factorResult.json as { factors: Array<{ id?: string; value?: unknown; evidence_ids?: string[] }> }).factors ?? [])
    : [];
  const judgedMap = new Map(judged.map((j) => [String(j.id), j]));

  for (const f of factors) {
    let value: 1 | 0 | null = null;
    if (f.name === "熬夜") {
      value = overnightValue(last, resolveTz((await getMeta()).timeZone));
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

  await recomputeStats();
  await writeDailyDigest(day);
  await warmupCoreIndex();
  // 手动整理（通常是还没结束的今天）不推进 lastDuskDay，这一天结束后自动 dusk 仍会完整重跑
  if (!opts.manual) {
    const meta = await getMeta();
    if (!meta.lastDuskDay || meta.lastDuskDay < day) await patchMeta({ lastDuskDay: day });
  }
}

export async function enqueuePeriodicIfDue(nowMs: number, timeZone: string): Promise<void> {
  const { lockedProfile } = await import("../../types.ts");
  const { getProfileData } = await import("../store.ts");
  const profile = lockedProfile(await getProfileData());
  if (!profile.diaryEnabled) return;
  const meta = await getMeta();
  if (meta.timeZone !== timeZone) await patchMeta({ timeZone });
  const today = localDay(nowMs, timeZone);
  if (today.slice(8) !== "01") return;
  const month = previousMonth(nowMs, timeZone);
  if (meta.lastReportMonth < month) {
    await enqueue("report", `report:${month}`, { month });
  }
}

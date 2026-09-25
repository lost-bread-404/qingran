import { callModel } from "./llm.ts";
import { appendBrainLog } from "./store.ts";
import { now } from "./clock.ts";
import { parsePromptBody, renderVariant } from "./prompts/doc.ts";
import { loadPrompt } from "./prompts/store.ts";
import { calendarDay, shiftDay } from "./time.ts";
import { newId } from "../storage.ts";
import { getSql } from "../../db.ts";
import { busyWord, periodOnDay, periodsOverlap, type BusyPeriod } from "./life.ts";
import {
  countProactiveBetween,
  identityHash,
  listBusyPeriods,
  profileClockZone,
  readIdentity,
  replaceBusyPeriods,
  writeRhythm,
  type BusyRow,
} from "./life-store.ts";

const BUSY_SCHEMA = {
  name: "busy",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["rhythm", "periods"],
    properties: {
      rhythm: { type: "string" },
      periods: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["from_day", "to_day", "busy", "label", "reason"],
          properties: {
            from_day: { type: "string" },
            to_day: { type: "string" },
            busy: { type: "number" },
            label: { type: "string" },
            reason: { type: "string" },
          },
        },
      },
    },
  },
};

export type CurrentBusy = { busy: number; label: string; reason: string; rhythm: string; fromDay: string; toDay: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function periodsContinuous(periods: Array<{ fromDay: string; toDay: string }>): boolean {
  if (!periods.length || periodsOverlap(periods)) return false;
  const sorted = [...periods].sort((a, b) => (a.fromDay < b.fromDay ? -1 : a.fromDay > b.fromDay ? 1 : 0));
  for (const row of sorted) {
    if (!DAY.test(row.fromDay) || !DAY.test(row.toDay) || row.fromDay > row.toDay) return false;
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.fromDay !== shiftDay(sorted[i - 1]!.toDay, 1)) return false;
  }
  return true;
}

export async function currentBusy(at = now()): Promise<CurrentBusy> {
  const [zone, rows, ident] = await Promise.all([profileClockZone(), listBusyPeriods(), readIdentity()]);
  const day = calendarDay(at, zone);
  const hit = periodOnDay(rows, day);
  if (!hit) return { busy: 0.5, label: "", reason: "", rhythm: ident.rhythm, fromDay: "", toDay: "" };
  return {
    busy: hit.busy,
    label: hit.label,
    reason: hit.reason,
    rhythm: ident.rhythm,
    fromDay: hit.fromDay,
    toDay: hit.toDay,
  };
}

export async function busyGeneratedAt(): Promise<number> {
  const rows = await listBusyPeriods();
  if (!rows.length) return 0;
  return Math.max(...rows.map((row) => row.createdAt));
}

function normalizePeriods(raw: unknown): BusyPeriod[] | string {
  if (!Array.isArray(raw) || !raw.length) return "没有时间段";
  const periods: BusyPeriod[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return "时间段读不出来";
    const row = item as Record<string, unknown>;
    const fromDay = String(row.from_day ?? row.fromDay ?? "").slice(0, 10);
    const toDay = String(row.to_day ?? row.toDay ?? "").slice(0, 10);
    const label = String(row.label ?? "").trim().slice(0, 80);
    const reason = String(row.reason ?? "").trim().slice(0, 400);
    const busy = Number(row.busy);
    if (!label) return "有一段时间没有名字";
    if (!Number.isFinite(busy)) return "忙碌程度不是数字";
    periods.push({
      id: typeof row.id === "string" && row.id.trim() ? row.id.trim() : newId(),
      fromDay,
      toDay,
      busy: Math.max(0, Math.min(1, busy)),
      label,
      reason,
    });
  }
  if (!periodsContinuous(periods)) return "时间段必须首尾相接，并且不能重叠";
  return periods;
}

export async function generateBusySchedule(complete: typeof callModel = callModel): Promise<{ periods: BusyRow[]; rhythm: string }> {
  const ident = await readIdentity();
  if (!ident.identity.trim()) throw new Error("先写身份");
  const zone = await profileClockZone();
  const today = calendarDay(now(), zone);
  const loaded = await loadPrompt("busy");
  const messages = renderVariant(parsePromptBody("busy", loaded.body), "main", {
    identity: ident.identity,
    today,
  });
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const user = messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n\n");
  const previous = await listBusyPeriods();
  const result = await complete("busy", {
    system,
    input: user || `今天是 ${today}。`,
    schema: BUSY_SCHEMA,
    promptKey: loaded.key,
    promptHash: loaded.hash,
    outputRef: "busy:generate",
  });
  if (!result.ok || !result.json || typeof result.json !== "object") {
    throw new Error(`busy:${result.failKind || "bad json"}`);
  }
  const json = result.json as Record<string, unknown>;
  const periods = normalizePeriods(json.periods);
  if (typeof periods === "string") throw new Error(periods);
  const rhythm = String(json.rhythm ?? "").trim().slice(0, 500);
  const hash = identityHash(ident.identity);
  await appendBrainLog({
    step: "busy-replace",
    ok: true,
    route: "busy",
    model: result.model,
    ms: result.ms,
    outputText: JSON.stringify({ previous, rhythm }),
    promptKey: loaded.key,
    promptHash: loaded.hash,
    note: "旧忙碌表备份",
  });
  await replaceBusyPeriods(periods, hash);
  await writeRhythm(rhythm);
  return { periods: await listBusyPeriods(), rhythm };
}

export async function saveBusyEdits(
  periods: BusyPeriod[],
  rhythm: string,
): Promise<BusyRow[]> {
  const normalized = normalizePeriods(periods.map((row) => ({
    id: row.id,
    from_day: row.fromDay,
    to_day: row.toDay,
    busy: row.busy,
    label: row.label,
    reason: row.reason,
  })));
  if (typeof normalized === "string") throw new Error(normalized);
  const ident = await readIdentity();
  const previous = await listBusyPeriods();
  await appendBrainLog({
    step: "busy-edit",
    ok: true,
    route: "busy",
    outputText: JSON.stringify(previous),
    note: "手改前的忙碌表",
  });
  await replaceBusyPeriods(normalized, identityHash(ident.identity));
  await writeRhythm(rhythm);
  return listBusyPeriods();
}

export async function lookupBusyRange(fromDay: string, toDay: string): Promise<{
  periods: Array<{ from_day: string; to_day: string; busy_word: string; label: string; reason: string }>;
  proactive_count: number;
  last_rosie_at: number | null;
}> {
  const from = DAY.test(fromDay) ? fromDay : "";
  const to = DAY.test(toDay) ? toDay : "";
  if (!from || !to || from > to) throw new Error("日期不对");
  const rows = await listBusyPeriods();
  const hit = rows.filter((row) => row.fromDay <= to && from <= row.toDay);
  const db = await getSql();
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${shiftDay(to, 1)}T00:00:00Z`);
  const users = await db.query<{ created_at: number }>(
    `select created_at from qingran_messages
     where role = 'user' and forgotten_at is null
     order by created_at desc limit 1`,
  );
  return {
    periods: hit.map((row) => ({
      from_day: row.fromDay,
      to_day: row.toDay,
      busy_word: busyWord(row.busy),
      label: row.label,
      reason: row.reason,
    })),
    proactive_count: await countProactiveBetween(fromMs, toMs),
    last_rosie_at: users[0] ? Number(users[0].created_at) : null,
  };
}

export type { BusyRow };

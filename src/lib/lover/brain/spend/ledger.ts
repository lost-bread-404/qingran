import { getSql } from "../../../db.ts";
import { now } from "../clock.ts";
import { getMeta } from "../store.ts";
import { localDay } from "../time.ts";
import { defaultSpendLimits, type SpendLimits, type SpendLevel, type SpendScope } from "./policy.ts";

export type SpendEventInput = {
  kind: "llm" | "tts" | "stt";
  route: string;
  model?: string | null;
  tokensIn?: number | null;
  tokensCached?: number | null;
  tokensOut?: number | null;
  tokensReasoning?: number | null;
  chars?: number | null;
  seconds?: number | null;
  usd: number;
  estimated?: boolean;
  turnSeq?: number | null;
  jobId?: string | null;
  logId?: number | null;
  at?: number;
};

type TotalsSnap = {
  day: string;
  month: string;
  dayUsd: number;
  monthUsd: number;
  byRoute: Record<string, number>;
  fetchedAt: number;
};

let snap: TotalsSnap | null = null;

export function resetSpendSnap() {
  snap = null;
}

export async function resolvedLimits(): Promise<SpendLimits> {
  const meta = await getMeta();
  return { ...defaultSpendLimits(), ...(meta.spendLimits ?? {}) };
}

export async function loadTotals(force = false): Promise<TotalsSnap> {
  const meta = await getMeta();
  const tz = meta.timeZone || "UTC";
  const ts = now();
  const day = localDay(ts, tz);
  const month = day.slice(0, 7);
  if (!force && snap && snap.day === day && snap.month === month && ts - snap.fetchedAt < 3_000) {
    return snap;
  }
  const db = await getSql();
  const rows = await db.query<{ day: string; usd: number; route: string }>(
    `select day, route, usd from spend_daily where day = $1 or day like $2`,
    [day, `${month}-%`],
  );
  let dayUsd = 0;
  let monthUsd = 0;
  const byRoute: Record<string, number> = {};
  for (const r of rows) {
    const usd = Number(r.usd) || 0;
    monthUsd += usd;
    if (r.day === day) {
      dayUsd += usd;
      byRoute[r.route] = (byRoute[r.route] ?? 0) + usd;
    }
  }
  snap = { day, month, dayUsd, monthUsd, byRoute, fetchedAt: ts };
  return snap;
}

export async function recordSpend(ev: SpendEventInput): Promise<void> {
  try {
    const meta = await getMeta();
    const tz = meta.timeZone || "UTC";
    const ts = ev.at ?? now();
    const day = localDay(ts, tz);
    const month = day.slice(0, 7);
    const db = await getSql();
    await db.query(
      `insert into spend_events (
         at, day, month, kind, route, model,
         tokens_in, tokens_cached, tokens_out, tokens_reasoning,
         chars, seconds, usd, estimated, turn_seq, job_id, log_id
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        ts,
        day,
        month,
        ev.kind,
        ev.route,
        ev.model ?? null,
        ev.tokensIn ?? null,
        ev.tokensCached ?? null,
        ev.tokensOut ?? null,
        ev.tokensReasoning ?? null,
        ev.chars ?? null,
        ev.seconds ?? null,
        ev.usd,
        ev.estimated ?? false,
        ev.turnSeq ?? null,
        ev.jobId ?? null,
        ev.logId ?? null,
      ],
    );
    await db.query(
      `insert into spend_daily (day, route, usd, calls) values ($1, $2, $3, 1)
       on conflict (day, route) do update set
         usd = spend_daily.usd + excluded.usd,
         calls = spend_daily.calls + 1`,
      [day, ev.route, ev.usd],
    );
    if (snap && snap.day === day) {
      snap.dayUsd += ev.usd;
      snap.monthUsd += ev.usd;
      snap.byRoute[ev.route] = (snap.byRoute[ev.route] ?? 0) + ev.usd;
    }
  } catch (err) {
    console.error("[spend] record failed", err);
  }
}

export async function listOverrides(day: string, month: string): Promise<{ day: boolean; month: boolean }> {
  const db = await getSql();
  const rows = await db.query<{ scope: string; period: string }>(
    `select scope, period from spend_overrides where (scope = 'day' and period = $1) or (scope = 'month' and period = $2)`,
    [day, month],
  );
  return {
    day: rows.some((r) => r.scope === "day"),
    month: rows.some((r) => r.scope === "month"),
  };
}

export async function writeAlert(
  scope: SpendScope | "rate",
  level: SpendLevel | "rate",
  totalUsd: number | null,
  detail: string,
): Promise<boolean> {
  try {
    const meta = await getMeta();
    const tz = meta.timeZone || "UTC";
    const ts = now();
    const day = localDay(ts, tz);
    const month = day.slice(0, 7);
    const db = await getSql();
    const period = scope === "month" ? month : day;
    const existing = await db.query<{ n: number }>(
      `select count(*)::int as n from spend_alerts
       where level = $1 and scope = $2
         and ((scope = 'month' and month = $3) or (scope <> 'month' and day = $4))`,
      [level, scope, month, period],
    );
    if (Number(existing[0]?.n) > 0) return false;
    await db.query(
      `insert into spend_alerts (at, day, month, scope, level, total_usd, detail)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [ts, day, month, scope, level, totalUsd, detail],
    );
    return true;
  } catch (err) {
    console.error("[spend] alert failed", err);
    return false;
  }
}

export async function insertOverride(scope: SpendScope, period: string, note: string): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into spend_overrides (scope, period, created_at, note) values ($1,$2,$3,$4)`,
    [scope, period, now(), note],
  );
}

export async function bumpRate(bucket: string): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `insert into spend_rate (bucket, n) values ($1, 1)
     on conflict (bucket) do update set n = spend_rate.n + 1
     returning n`,
    [bucket],
  );
  return Number(rows[0]?.n) || 1;
}

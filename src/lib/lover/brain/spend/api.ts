import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { failAttempt, isLimited, clientIp } from "../../../auth-lite/attempts.ts";
import { passwordsMatch } from "../../../auth-lite/session.ts";
import { getSql } from "../../../db.ts";
import { now } from "../clock.ts";
import { getMeta, patchMeta } from "../store.ts";
import { localDay, shiftDay } from "../time.ts";
import { resolveTz } from "../tz.ts";
import { insertOverride, listOverrides, loadTotals, resolvedLimits } from "./ledger.ts";
import {
  defaultSpendLimits,
  spendDecision,
  validateSpendLimits,
  type SpendLimits,
  type SpendScope,
} from "./policy.ts";

function asNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asNumOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asStr(v: unknown): string {
  return v == null ? "" : String(v);
}

function asStrOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}

export type SpendEventRow = {
  id: number;
  at: number;
  day: string;
  month: string;
  kind: string;
  route: string;
  model: string | null;
  tokens_in: number | null;
  tokens_cached: number | null;
  tokens_out: number | null;
  tokens_reasoning: number | null;
  chars: number | null;
  seconds: number | null;
  usd: number;
  usd_est: number | null;
  cost_source: string | null;
  estimated: boolean;
  turn_seq: number | null;
  job_id: string | null;
  log_id: number | null;
};

export type SpendAlertRow = {
  id: number;
  at: number;
  day: string;
  month: string;
  scope: string;
  level: string;
  total_usd: number | null;
  detail: string | null;
};

export type SpendTopRow = {
  id: number;
  at: number;
  route: string;
  model: string | null;
  usd: number;
  estimated: boolean;
  turn_seq: number | null;
  log_id: number | null;
  job_id: string | null;
};

export type SpendDailyRow = { day: string; route: string; usd: number; calls: number };
export type SpendMonthEventRow = {
  route: string;
  model: string | null;
  usd: number;
  n: number;
};
export type SpendReconcileRow = {
  month: string;
  actual_usd: number;
  estimated_usd: number;
  entered_at: number;
};

function mapEvent(r: Record<string, unknown>): SpendEventRow {
  return {
    id: asNum(r.id),
    at: asNum(r.at),
    day: asStr(r.day),
    month: asStr(r.month),
    kind: asStr(r.kind),
    route: asStr(r.route),
    model: asStrOrNull(r.model),
    tokens_in: asNumOrNull(r.tokens_in),
    tokens_cached: asNumOrNull(r.tokens_cached),
    tokens_out: asNumOrNull(r.tokens_out),
    tokens_reasoning: asNumOrNull(r.tokens_reasoning),
    chars: asNumOrNull(r.chars),
    seconds: asNumOrNull(r.seconds),
    usd: asNum(r.usd),
    usd_est: asNumOrNull(r.usd_est),
    cost_source: asStrOrNull(r.cost_source),
    estimated: r.estimated === true || r.estimated === "t",
    turn_seq: asNumOrNull(r.turn_seq),
    job_id: asStrOrNull(r.job_id),
    log_id: asNumOrNull(r.log_id),
  };
}

export const brainGetSpendOverview = createServerFn({ method: "GET" }).handler(async () => {
  const [meta, limits, totals] = await Promise.all([getMeta(), resolvedLimits(), loadTotals(true)]);
  const tz = resolveTz(meta.timeZone);
  const overrides = await listOverrides(totals.day, totals.month);
  const decision = spendDecision("voice", totals.dayUsd, totals.monthUsd, limits, overrides, now(), tz);
  const dayOfMonth = Number(totals.day.slice(8, 10)) || 1;
  const [y, m] = totals.month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y ?? 2026, m ?? 1, 0)).getUTCDate();
  const forecast = (totals.monthUsd / dayOfMonth) * daysInMonth;
  const db = await getSql();
  const dailyRaw = await db.query<Record<string, unknown>>(
    `select day, route, usd, calls from spend_daily where day >= $1 order by day`,
    [shiftDay(totals.day, -90)],
  );
  const daily: SpendDailyRow[] = dailyRaw.map((r) => ({
    day: asStr(r.day),
    route: asStr(r.route),
    usd: asNum(r.usd),
    calls: asNum(r.calls),
  }));
  const monthRaw = await db.query<Record<string, unknown>>(
    `select route, model, sum(usd)::real as usd, count(*)::int as n
     from spend_events where month = $1 group by route, model`,
    [totals.month],
  );
  const monthEvents: SpendMonthEventRow[] = monthRaw.map((r) => ({
    route: asStr(r.route),
    model: asStrOrNull(r.model),
    usd: asNum(r.usd),
    n: asNum(r.n),
  }));
  const perTurn = await db.query<{ turn_seq: number; usd: number }>(
    `select turn_seq, sum(usd)::real as usd from spend_events
     where month = $1 and turn_seq is not null and route in ('voice','tts','stt','reflect')
     group by turn_seq`,
    [totals.month],
  );
  const avgTurn = perTurn.length ? perTurn.reduce((s, r) => s + asNum(r.usd), 0) / perTurn.length : 0;
  const topRaw = await db.query<Record<string, unknown>>(
    `select id, at, route, model, usd, estimated, turn_seq, log_id, job_id
     from spend_events where day = $1 order by usd desc limit 10`,
    [totals.day],
  );
  const top: SpendTopRow[] = topRaw.map((r) => ({
    id: asNum(r.id),
    at: asNum(r.at),
    route: asStr(r.route),
    model: asStrOrNull(r.model),
    usd: asNum(r.usd),
    estimated: r.estimated === true || r.estimated === "t",
    turn_seq: asNumOrNull(r.turn_seq),
    log_id: asNumOrNull(r.log_id),
    job_id: asStrOrNull(r.job_id),
  }));
  const alertRaw = await db.query<Record<string, unknown>>(
    `select id, at, day, month, scope, level, total_usd, detail from spend_alerts order by at desc limit 50`,
  );
  const alerts: SpendAlertRow[] = alertRaw.map((r) => ({
    id: asNum(r.id),
    at: asNum(r.at),
    day: asStr(r.day),
    month: asStr(r.month),
    scope: asStr(r.scope),
    level: asStr(r.level),
    total_usd: asNumOrNull(r.total_usd),
    detail: asStrOrNull(r.detail),
  }));
  const recRaw = await db.query<Record<string, unknown>>(
    `select month, actual_usd, estimated_usd, entered_at from spend_reconcile order by month desc limit 12`,
  );
  const reconcile: SpendReconcileRow[] = recRaw.map((r) => ({
    month: asStr(r.month),
    actual_usd: asNum(r.actual_usd),
    estimated_usd: asNum(r.estimated_usd),
    entered_at: asNum(r.entered_at),
  }));
  const srcRaw = await db.query<{ src: string | null; usd: number; n: number }>(
    `select cost_source as src, coalesce(sum(usd),0)::real as usd, count(*)::int as n
     from spend_events where month = $1 group by cost_source`,
    [totals.month],
  );
  const xaiUsd = srcRaw.filter((r) => r.src === "xai").reduce((s, r) => s + asNum(r.usd), 0);
  const allUsd = srcRaw.reduce((s, r) => s + asNum(r.usd), 0);
  const xaiShare = allUsd > 0 ? xaiUsd / allUsd : 0;
  const devRaw = await db.query<{ route: string; usd: number; usd_est: number }>(
    `select route, coalesce(sum(usd),0)::real as usd, coalesce(sum(usd_est),0)::real as usd_est
     from spend_events where month = $1 group by route`,
    [totals.month],
  );
  const routeDeviation = devRaw.map((r) => {
    const usd = asNum(r.usd);
    const est = asNum(r.usd_est);
    const deviation = est === 0 ? (usd === 0 ? 0 : 1) : Math.abs(usd - est) / est;
    return { route: asStr(r.route), usd, usdEst: est, deviation };
  });
  return {
    day: totals.day,
    month: totals.month,
    dayUsd: totals.dayUsd,
    monthUsd: totals.monthUsd,
    forecast,
    limits,
    decision,
    overrides,
    daily,
    monthEvents,
    avgTurn,
    top,
    alerts,
    reconcile,
    xaiShare,
    xaiUsd,
    routeDeviation,
  };
});

export const brainListSpendEvents = createServerFn({ method: "POST" })
  .validator((input: { day?: string; route?: string; limit?: number }) => input)
  .handler(async ({ data }): Promise<SpendEventRow[]> => {
    const db = await getSql();
    const day = data.day || "";
    const route = data.route || "";
    const rows = await db.query<Record<string, unknown>>(
      `select id, at, day, month, kind, route, model, tokens_in, tokens_cached, tokens_out,
              tokens_reasoning, chars, seconds, usd, estimated, turn_seq, job_id, log_id, usd_est, cost_source
       from spend_events
       where ($1 = '' or day = $1) and ($2 = '' or route = $2)
       order by at desc limit $3`,
      [day, route, Math.min(data.limit ?? 80, 200)],
    );
    return rows.map(mapEvent);
  });

export const brainSaveSpendLimits = createServerFn({ method: "POST" })
  .validator((input: SpendLimits) => input)
  .handler(async ({ data }) => {
    const err = validateSpendLimits(data);
    if (err) return { ok: false as const, error: err };
    await patchMeta({ spendLimits: data });
    return { ok: true as const, limits: data };
  });

export const brainSpendOverride = createServerFn({ method: "POST" })
  .validator((input: { scope: SpendScope; password: string }) => input)
  .handler(async ({ data }) => {
    const expected = process.env.APP_PASSWORD ?? "";
    const ip = clientIp(getRequest()?.headers.get("x-forwarded-for"));
    const ts = now();
    if (await isLimited(ip, ts)) return { ok: false as const, error: "试得太勤了，过一会儿再来。" };
    if (!expected || !passwordsMatch(data.password, expected)) {
      await failAttempt(ip, ts);
      return { ok: false as const, error: "密码不对。" };
    }
    const meta = await getMeta();
    const tz = resolveTz(meta.timeZone);
    const day = localDay(ts, tz);
    const period = data.scope === "month" ? day.slice(0, 7) : day;
    await insertOverride(data.scope, period, "password");
    return { ok: true as const };
  });

export const brainSpendReconcile = createServerFn({ method: "POST" })
  .validator((input: { month: string; actualUsd: number }) => input)
  .handler(async ({ data }) => {
    if (!/^\d{4}-\d{2}$/.test(data.month) || !Number.isFinite(data.actualUsd) || data.actualUsd < 0) {
      return { ok: false as const, error: "月份或金额不对。" };
    }
    const db = await getSql();
    const est = await db.query<{ s: number }>(
      `select coalesce(sum(usd),0)::real as s from spend_events where month = $1`,
      [data.month],
    );
    const estimated = asNum(est[0]?.s);
    await db.query(
      `insert into spend_reconcile (month, actual_usd, estimated_usd, entered_at)
       values ($1,$2,$3,$4)
       on conflict (month) do update set actual_usd = excluded.actual_usd, estimated_usd = excluded.estimated_usd, entered_at = excluded.entered_at`,
      [data.month, data.actualUsd, estimated, now()],
    );
    const diff = estimated === 0 ? (data.actualUsd === 0 ? 0 : 1) : Math.abs(data.actualUsd - estimated) / estimated;
    return { ok: true as const, estimated, actual: data.actualUsd, diff };
  });

export const brainExportSpendCsv = createServerFn({ method: "POST" })
  .validator((input: { month: string }) => input)
  .handler(async ({ data }) => {
    const db = await getSql();
    const rows = await db.query<Record<string, unknown>>(
      `select id, at, day, month, kind, route, model, tokens_in, tokens_cached, tokens_out,
              tokens_reasoning, chars, seconds, usd, estimated, turn_seq, job_id, log_id, usd_est, cost_source
       from spend_events where month = $1 order by at`,
      [data.month],
    );
    const cols = [
      "id", "at", "day", "month", "kind", "route", "model", "tokens_in", "tokens_cached",
      "tokens_out", "tokens_reasoning", "chars", "seconds", "usd", "estimated", "turn_seq", "job_id", "log_id",
    ];
    const lines = [cols.join(",")];
    for (const r of rows) {
      lines.push(cols.map((c) => JSON.stringify(r[c] ?? "")).join(","));
    }
    return { csv: lines.join("\n"), month: data.month };
  });

export const brainArchiveOldSpend = createServerFn({ method: "POST" }).handler(async () => {
  const meta = await getMeta();
  const tz = resolveTz(meta.timeZone);
  const cutoff = shiftDay(localDay(now(), tz), -365);
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `with d as (delete from spend_events where day < $1 returning id) select count(*)::int as n from d`,
    [cutoff],
  );
  return { ok: true as const, deleted: asNum(rows[0]?.n) };
});

export { defaultSpendLimits, validateSpendLimits };

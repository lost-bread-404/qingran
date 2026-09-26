import { getSql } from "../../db.ts";
import { now } from "./clock.ts";
import { LOG_TEXT_DAYS, SNAPSHOT_DAYS } from "./config.ts";
import { logRawHours } from "./log-refs.ts";

const BATCH = 500;

/** turn_traces / turn_feedback are kept at least 90 days and are not trimmed here. */

async function updateBatch(sql: string, params: unknown[]): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ n: number }>(`with u as (${sql}) select count(*)::int as n from u`, params);
  return Number(rows[0]?.n) || 0;
}

async function trimLogText(nowMs: number): Promise<number> {
  const cutoff = nowMs - LOG_TEXT_DAYS * 86_400_000;
  return updateBatch(
    `update brain_log set
       raw = left(coalesce(output_text, raw, ''), 300),
       output_text = null,
       input_system = null,
       input_user = null,
       trimmed = true
     where id in (
       select id from brain_log
       where at < $1 and trimmed = false
         and (input_system is not null or input_user is not null or coalesce(length(output_text), 0) > 300)
       order by id limit $2
     )
     returning id`,
    [cutoff, BATCH],
  );
}

async function clearTurnTails(): Promise<number> {
  return updateBatch(
    `update brain_turns set tail = null
     where turn_seq in (
       select turn_seq from brain_turns
       where tail is not null and length(tail) > 0
       order by turn_seq limit $1
     )
     returning turn_seq`,
    [BATCH],
  );
}

async function trimSnapshots(nowMs: number): Promise<number> {
  const cutoff = nowMs - SNAPSHOT_DAYS * 86_400_000;
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `with d as (
       delete from qr_block_snapshots s
       where s.last_seen < $1
         and not exists (
           select 1 from brain_log l
           where l.refs is not null
             and (l.refs->>'longtermHash' = s.hash or l.refs->>'blockBHash' = s.hash)
         )
       returning 1
     )
     select count(*)::int as n from d`,
    [cutoff],
  );
  return Number(rows[0]?.n) || 0;
}

async function rollupAndTrimSpend(nowMs: number): Promise<number> {
  const cutoff = nowMs - 90 * 86_400_000;
  const db = await getSql();
  await db.query(
    `insert into spend_daily (day, route, usd, calls)
     select day, route, sum(usd)::real, count(*)::int
     from spend_events e
     where e.at < $1
       and not exists (select 1 from spend_daily d where d.day = e.day and d.route = e.route)
     group by day, route`,
    [cutoff],
  );
  await db.query(
    `insert into spend_monthly (month, route, model, usd, calls, tokens_in, tokens_cached, tokens_out)
     select month, route, coalesce(model, ''), sum(usd)::real, count(*)::int,
            coalesce(sum(tokens_in),0)::bigint, coalesce(sum(tokens_cached),0)::bigint, coalesce(sum(tokens_out),0)::bigint
     from spend_events e
     where e.at < $1
       and not exists (
         select 1 from spend_monthly m
         where m.month = e.month and m.route = e.route and m.model = coalesce(e.model, '')
       )
     group by month, route, coalesce(model, '')`,
    [cutoff],
  );
  const rows = await db.query<{ n: number }>(
    `with d as (delete from spend_events where at < $1 returning id) select count(*)::int as n from d`,
    [cutoff],
  );
  return Number(rows[0]?.n) || 0;
}

async function trimRawLogs(nowMs: number): Promise<number> {
  const hours = logRawHours();
  const cutoff = hours > 0 ? nowMs - hours * 3_600_000 : nowMs - LOG_TEXT_DAYS * 86_400_000;
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `with d as (delete from brain_log_raw where at < $1 returning log_id) select count(*)::int as n from d`,
    [cutoff],
  );
  return Number(rows[0]?.n) || 0;
}

async function trimSpendRate(nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - 24 * 3_600_000).toISOString().slice(0, 16);
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `with d as (
       delete from spend_rate where right(bucket, 16) < $1 returning bucket
     ) select count(*)::int as n from d`,
    [cutoff],
  );
  return Number(rows[0]?.n) || 0;
}

async function tryVacuum(): Promise<boolean> {
  try {
    const db = await getSql();
    await db.query("vacuum");
    return true;
  } catch {
    return false;
  }
}

export type RetentionResult = {
  logText: number;
  legacyHighFreq: number;
  tails: number;
  snapshots: number;
  spendEvents: number;
  rawLogs: number;
  spendRate: number;
  vacuum: boolean;
};

export async function runRetention(nowMs = now()): Promise<RetentionResult> {
  const result: RetentionResult = {
    logText: 0,
    legacyHighFreq: 0,
    tails: 0,
    snapshots: 0,
    spendEvents: 0,
    rawLogs: 0,
    spendRate: 0,
    vacuum: false,
  };
  try {
    for (let i = 0; i < 40; i++) {
      const n = await trimLogText(nowMs);
      result.logText += n;
      if (n < BATCH) break;
    }
    for (let i = 0; i < 40; i++) {
      const n = await clearTurnTails();
      result.tails += n;
      if (n < BATCH) break;
    }
    result.snapshots = await trimSnapshots(nowMs);
    result.spendEvents = await rollupAndTrimSpend(nowMs);
    result.rawLogs = await trimRawLogs(nowMs);
    result.spendRate = await trimSpendRate(nowMs);
    if (result.legacyHighFreq || result.tails || result.logText) {
      result.vacuum = await tryVacuum();
    }
  } catch (err) {
    console.error("[retention] failed", err);
  }
  return result;
}

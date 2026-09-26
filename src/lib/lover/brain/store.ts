import { getSql, type Sql } from "../../db.ts";
import { NEUTRAL_PERSONA, storedSystemPrompt } from "../types.ts";
import { newId } from "../storage.ts";
import { collapseReplyVariants } from "../pair-messages.ts";
import { HISTORY_WINDOW, SESSION_GAP_MS } from "./config.ts";
import { clipLogRecord } from "./log-clip.ts";
import { now } from "./clock.ts";
import { localDay, sessionIdFor } from "./time.ts";
import type {
  BrainJob,
  BrainLogRow,
  BrainMeta,
  JobStatus,
  JobType,
  StoredMessage,
} from "./types.ts";
import { EMPTY_META } from "./types.ts";


export function pgTextArray(values: string[]): string {
  const escaped = values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

export function fromPgArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value == null) return [];
  if (typeof value === "string") {
    const t = value.trim();
    if (!t || t === "{}") return [];
    if (t.startsWith("{") && t.endsWith("}")) {
      const inner = t.slice(1, -1);
      if (!inner) return [];
      const out: string[] = [];
      let cur = "";
      let inQuote = false;
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i]!;
        const prev = inner[i - 1];
        if (ch === '"' && prev !== "\\") {
          inQuote = !inQuote;
          continue;
        }
        if (ch === "," && !inQuote) {
          out.push(unescapePg(cur));
          cur = "";
          continue;
        }
        cur += ch;
      }
      out.push(unescapePg(cur));
      return out.filter((s) => s.length > 0);
    }
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function unescapePg(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function asInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asIntOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

export async function sql(): Promise<Sql> {
  return getSql();
}

export async function getMeta(): Promise<BrainMeta> {
  const db = await getSql();
  const rows = await db.query<{ data: unknown }>("select data from brain_meta where id = 1");
  const data = asJson<Partial<BrainMeta>>(rows[0]?.data, {});
  return { ...EMPTY_META, ...data };
}

export async function patchMeta(patch: Partial<BrainMeta>): Promise<BrainMeta> {
  const current = await getMeta();
  const next = { ...current, ...patch };
  const db = await getSql();
  await db.query("update brain_meta set data = $1::jsonb where id = 1", [JSON.stringify(next)]);
  return next;
}

export async function appendInnerLog(entry: {
  turnSeq: number;
  data: unknown;
  model?: string | null;
  ms?: number | null;
}): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into qr_inner_log (turn_seq, created_at, data, model, ms) values ($1,$2,$3::jsonb,$4,$5)`,
    [entry.turnSeq, now(), JSON.stringify(entry.data ?? {}), entry.model ?? null, entry.ms ?? null],
  );
}

/** Clearing the room also clears what he had in mind right now (the plans with a time stay). */
export async function resetInnerTurn(): Promise<void> {
  const db = await getSql();
  await db.query(`update qr_inner set now_text = '', focus = '', turn_seq = 0, updated_at = $1 where id = 1`, [now()]);
}

export async function forgetUnarchivedMessages(at: number): Promise<number> {
  const db = await getSql();
  const dossier = await db.query<{ active: boolean; cursor_at: number }>(
    "select active, cursor_at from qr_dossier where id = 1",
  );
  const active = asBool(dossier[0]?.active);
  const cursor = Number(dossier[0]?.cursor_at ?? 0) || 0;
  if (active) {
    const rows = await db.query<{ n: number }>(
      `with u as (
         update qingran_messages
         set forgotten_at = $1
         where created_at > $2 and forgotten_at is null
         returning id
       ) select count(*)::int as n from u`,
      [at, cursor],
    );
    return asInt(rows[0]?.n);
  }
  const rows = await db.query<{ n: number }>(
    `with u as (
       update qingran_messages
       set forgotten_at = $1
       where archived_at is null and forgotten_at is null
       returning id
     ) select count(*)::int as n from u`,
    [at],
  );
  return asInt(rows[0]?.n);
}

export async function setRoomClearedAt(at: number): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into qingran_profile (id, data, room_cleared_at, updated_at)
     values (1, '{}'::jsonb, $1, now())
     on conflict (id) do update set room_cleared_at = excluded.room_cleared_at, updated_at = now()`,
    [at],
  );
}

/** Hide recent turns not yet folded into memory, from the screen and from Qingran; rows stay for analysis.
 * His heart is emptied (it may hold the stuck topic) and what he meant to do next is dropped.
 * Plans with a time (dinner, bedtime), plans she added, and the memory stay. */
export async function clearRecentConversation(): Promise<void> {
  const ts = now();
  const { dropUntimedPlans, getHeart } = await import("./heart.ts");
  const heart = await getHeart();
  await setRoomClearedAt(ts);
  await forgetUnarchivedMessages(ts);
  await resetInnerTurn();
  await dropUntimedPlans();
  await appendInnerLog({
    turnSeq: heart.turnSeq,
    data: { kind: "cleared_by_rosie" },
  });
}


function rowMessage(r: Record<string, unknown>): StoredMessage {
  return {
    id: String(r.id),
    role: r.role === "assistant" ? "assistant" : "user",
    text: String(r.body ?? ""),
    createdAt: asInt(r.created_at),
    kind:
      r.kind === "steer" || r.kind === "setting" || r.kind === "proactive" || r.kind === "system_notice"
        ? r.kind
        : "say",
    archivedAt: asIntOrNull(r.archived_at),
    sessionId: r.session_id ? String(r.session_id) : null,
    localDay: r.local_day ? String(r.local_day) : null,
  };
}

export async function listRecentMessages(limit = 240): Promise<StoredMessage[]> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
     order by created_at desc, id desc
     limit $1`,
    [limit],
  );
  return rows.map(rowMessage).reverse();
}

export async function listHistoryWindow(
  excludeId: string | null,
  limit = HISTORY_WINDOW,
  beforeCreatedAt: number | null = null,
): Promise<StoredMessage[]> {
  if (limit <= 0) return [];
  const db = await getSql();
  const fetchN = Math.min(limit + 32, 240);
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where ($1::text is null or id <> $1)
       and forgotten_at is null
       and kind is distinct from 'system_notice'
       and created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
       and ($3::bigint is null or created_at < $3)
     order by created_at desc, id desc
     limit $2`,
    [excludeId, fetchN, beforeCreatedAt],
  );
  return collapseReplyVariants(rows.map(rowMessage).reverse())
    .filter((message) => {
      if (!excludeId || message.role !== "assistant") return true;
      return !message.text.includes(`⟦回:${excludeId}⟧`);
    })
    .slice(-limit);
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages where id = $1`,
    [id],
  );
  return rows[0] ? rowMessage(rows[0]) : null;
}

export async function lastMessage(): Promise<StoredMessage | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select id, role, body, created_at, kind, archived_at, session_id, local_day
     from qingran_messages
     where created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
     order by created_at desc, id desc
     limit 1`,
  );
  return rows[0] ? rowMessage(rows[0]) : null;
}

export async function upsertMessage(msg: {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  kind?: StoredMessage["kind"];
  timeZone: string;
}): Promise<StoredMessage> {
  const db = await getSql();
  const prev = await lastMessage();
  const day = localDay(msg.createdAt, msg.timeZone);
  const sess = sessionIdFor(
    msg.createdAt,
    prev ? { createdAt: prev.createdAt, sessionId: prev.sessionId || `s:${prev.createdAt}` } : null,
    msg.timeZone,
  );
  const kind = msg.kind ?? "say";
  await db.query(
    `insert into qingran_messages (id, role, body, created_at, kind, session_id, local_day)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do update set
       body = excluded.body,
       kind = excluded.kind,
       session_id = coalesce(qingran_messages.session_id, excluded.session_id),
       local_day = coalesce(qingran_messages.local_day, excluded.local_day)`,
    [msg.id, msg.role, msg.text, msg.createdAt, kind, sess, day],
  );
  return {
    id: msg.id,
    role: msg.role,
    text: msg.text,
    createdAt: msg.createdAt,
    kind,
    archivedAt: null,
    sessionId: sess,
    localDay: day,
  };
}

export async function updateMessageText(id: string, text: string, kind?: StoredMessage["kind"]): Promise<void> {
  const existing = await getMessage(id);
  const db = await getSql();
  const next = text;
  const ts = now();
  if (existing && existing.text !== next) {
    await db.query(
      `insert into qingran_message_edits (message_id, before, at) values ($1,$2,$3)`,
      [id, existing.text, ts],
    );
  }
  if (existing && existing.role === "user" && existing.text !== next) {
    // Same-sounding swaps she made by hand: candidates for the xAI keyterms, reviewed later in 听力.
    try {
      const { homophoneSwaps } = await import("../hearing/homophone-edits.ts");
      for (const swap of homophoneSwaps(existing.text, next)) {
        await db.query(
          `insert into qr_homophone_edits (at, message_id, wrong, correct, before, after) values ($1,$2,$3,$4,$5,$6)`,
          [ts, id, swap.wrong, swap.correct, existing.text.slice(0, 500), next.slice(0, 500)],
        );
      }
    } catch {
      // Never block an edit on this.
    }
  }
  if (kind) {
    await db.query(
      `update qingran_messages set body = $2, kind = $3, edited_at = $4 where id = $1`,
      [id, next, kind, ts],
    );
  } else {
    await db.query(`update qingran_messages set body = $2, edited_at = $3 where id = $1`, [id, next, ts]);
  }
}

export async function upsertReport(row: {
  id: string; periodStart: string; periodEnd: string; data: unknown; narrative: string; createdAt: number;
}): Promise<void> {
  const db = await getSql();
  await db.query(
    `insert into diary_reports (id, period_start, period_end, data, narrative, created_at)
     values ($1,$2,$3,$4::jsonb,$5,$6)
     on conflict (id) do update set data = excluded.data, narrative = excluded.narrative`,
    [row.id, row.periodStart, row.periodEnd, JSON.stringify(row.data), row.narrative, row.createdAt],
  );
}

export async function listReports() {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from diary_reports order by period_start desc");
  return rows.map((r) => ({
    id: String(r.id),
    periodStart: String(r.period_start),
    periodEnd: String(r.period_end),
    data: asJson(r.data, {}),
    narrative: String(r.narrative ?? ""),
    createdAt: asInt(r.created_at),
  }));
}

function rowJob(r: Record<string, unknown>): BrainJob {
  return {
    id: String(r.id),
    type: r.type as JobType,
    dedupeKey: String(r.dedupe_key),
    payload: asJson(r.payload, {}),
    status: r.status as JobStatus,
    attempts: asInt(r.attempts),
    runAfter: asInt(r.run_after),
    lockedUntil: asIntOrNull(r.locked_until),
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: asInt(r.created_at),
    updatedAt: asInt(r.updated_at),
  };
}

export async function insertJob(job: BrainJob, force = false): Promise<boolean> {
  const db = await getSql();
  if (force) {
    await db.query(
      `insert into brain_jobs (id, type, dedupe_key, payload, status, attempts, run_after, created_at, updated_at)
       values ($1,$2,$3,$4::jsonb,'pending',0,$5,$6,$6)
       on conflict (dedupe_key) do update set
         status = 'pending', attempts = 0, run_after = excluded.run_after, last_error = null,
         payload = excluded.payload, updated_at = excluded.updated_at, locked_until = null`,
      [job.id, job.type, job.dedupeKey, JSON.stringify(job.payload), job.runAfter, job.createdAt],
    );
    return true;
  }
  const rows = await db.query<{ id: string }>(
    `insert into brain_jobs (id, type, dedupe_key, payload, status, attempts, run_after, created_at, updated_at)
     values ($1,$2,$3,$4::jsonb,'pending',0,$5,$6,$6)
     on conflict (dedupe_key) do nothing returning id`,
    [job.id, job.type, job.dedupeKey, JSON.stringify(job.payload), job.runAfter, job.createdAt],
  );
  return rows.length > 0;
}

export async function peekNextJob(at: number): Promise<BrainJob | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select * from brain_jobs
     where (status = 'pending' and run_after <= $1) or (status = 'running' and locked_until < $1)
     order by case type
       when 'reflect' then 0 when 'archive' then 1 when 'dusk' then 2
       when 'backfill' then 3 when 'synth' then 4 else 5 end, run_after
     limit 1`,
    [at],
  );
  return rows[0] ? rowJob(rows[0]) : null;
}

export async function countPendingJobs(): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from brain_jobs where status in ('pending','running')`,
  );
  return asInt(rows[0]?.n);
}

export async function listJobStatus(): Promise<{
  pending: number;
  running: number;
  pendingTypes: JobType[];
  runningTypes: JobType[];
  recent: Array<{ type: JobType; status: JobStatus; updatedAt: number; lastError: string | null }>;
}> {
  const db = await getSql();
  const counts = await db.query<{ status: string; type: string; n: number }>(
    `select status, type, count(*)::int as n
     from brain_jobs
     where status in ('pending','running')
     group by status, type`,
  );
  let pending = 0;
  let running = 0;
  const pendingTypes: JobType[] = [];
  const runningTypes: JobType[] = [];
  for (const row of counts) {
    const n = asInt(row.n);
    if (row.status === "running") {
      running += n;
      runningTypes.push(row.type as JobType);
    } else {
      pending += n;
      pendingTypes.push(row.type as JobType);
    }
  }
  const recentRows = await db.query<Record<string, unknown>>(
    `select type, status, updated_at, last_error from brain_jobs order by updated_at desc limit 10`,
  );
  return {
    pending,
    running,
    pendingTypes,
    runningTypes,
    recent: recentRows.map((r) => ({
      type: r.type as JobType,
      status: r.status as JobStatus,
      updatedAt: asInt(r.updated_at),
      lastError: r.last_error ? String(r.last_error) : null,
    })),
  };
}

export async function claimJob(nowMs: number, lockMs: number, preferId?: string): Promise<BrainJob | null> {
  const db = await getSql();
  if (preferId) {
    const updated = await db.query<Record<string, unknown>>(
      `update brain_jobs
       set status = 'running', locked_until = $2, attempts = attempts + 1, updated_at = $3
       where id = $1 and ((status = 'pending' and run_after <= $3) or (status = 'running' and locked_until < $3))
       returning *`,
      [preferId, nowMs + lockMs, nowMs],
    );
    return updated[0] ? rowJob(updated[0]) : null;
  }
  const candidates = await db.query<Record<string, unknown>>(
    `select * from brain_jobs
     where (status = 'pending' and run_after <= $1) or (status = 'running' and locked_until < $1)
     order by case type
       when 'reflect' then 0 when 'archive' then 1 when 'dusk' then 2
       when 'backfill' then 3 when 'synth' then 4 else 5 end, run_after
     limit 8`,
    [nowMs],
  );
  for (const row of candidates) {
    const job = rowJob(row);
    const updated = await db.query<Record<string, unknown>>(
      `update brain_jobs
       set status = 'running', locked_until = $2, attempts = attempts + 1, updated_at = $3
       where id = $1 and (status = 'pending' or locked_until < $3)
       returning *`,
      [job.id, nowMs + lockMs, nowMs],
    );
    if (updated[0]) return rowJob(updated[0]);
  }
  return null;
}

export async function finishJob(id: string, status: "done" | "failed" | "pending", extra?: {
  runAfter?: number; error?: string;
}): Promise<void> {
  const db = await getSql();
  await db.query(
    `update brain_jobs set status = $2, run_after = coalesce($3, run_after), last_error = $4, locked_until = null, updated_at = $5 where id = $1`,
    [id, status, extra?.runAfter ?? null, extra?.error ?? null, now()],
  );
}

export async function deferJob(id: string, runAfter: number, error: string): Promise<void> {
  const db = await getSql();
  await db.query(
    `update brain_jobs
     set status = 'pending', run_after = $2, last_error = $3, locked_until = null, updated_at = $4
     where id = $1`,
    [id, runAfter, error, now()],
  );
}

export async function deferPendingUntil(runAfter: number, error: string): Promise<number> {
  const db = await getSql();
  const rows = await db.query<{ n: number }>(
    `with u as (
       update brain_jobs
       set status = 'pending', run_after = $1, last_error = $2, locked_until = null, updated_at = $3
       where status in ('pending','running') and run_after <= $3
       returning id
     ) select count(*)::int as n from u`,
    [runAfter, error, now()],
  );
  return asInt(rows[0]?.n);
}

export async function restoreClaim(id: string, attempts: number): Promise<void> {
  const db = await getSql();
  await db.query(
    `update brain_jobs
     set status = 'pending', locked_until = null, attempts = $2, updated_at = $3
     where id = $1`,
    [id, Math.max(0, attempts - 1), now()],
  );
}

export const REFLECT_DEDUPE_KEY = "reflect";

export async function upsertReflectJob(turnSeq: number): Promise<void> {
  const db = await getSql();
  const ts = now();
  await db.query(
    `insert into brain_jobs (id, type, dedupe_key, payload, status, attempts, run_after, created_at, updated_at)
     values ($1, 'reflect', $2, $3::jsonb, 'pending', 0, $4, $4, $4)
     on conflict (dedupe_key) do update set
       payload = jsonb_build_object(
         'turnSeq', greatest(
           coalesce((brain_jobs.payload->>'turnSeq')::bigint, 0),
           (excluded.payload->>'turnSeq')::bigint
         )
       ),
       status = case when brain_jobs.status = 'running' then 'running' else 'pending' end,
       run_after = case when brain_jobs.status = 'running' then brain_jobs.run_after else excluded.run_after end,
       attempts = case when brain_jobs.status = 'running' then brain_jobs.attempts else 0 end,
       last_error = case when brain_jobs.status = 'running' then brain_jobs.last_error else null end,
       locked_until = case when brain_jobs.status = 'running' then brain_jobs.locked_until else null end,
       updated_at = excluded.updated_at`,
    [newId(), REFLECT_DEDUPE_KEY, JSON.stringify({ turnSeq }), ts],
  );
}

/** Atomically done-or-reopen so a concurrent upsertReflectJob cannot lose a follow-up. */
export async function finishReflectJob(id: string, ranSeq: number): Promise<"pending" | "done"> {
  const db = await getSql();
  const ts = now();
  const rows = await db.query<{ status: string }>(
    `update brain_jobs
     set status = case
           when coalesce((payload->>'turnSeq')::bigint, 0) > $2 then 'pending'
           else 'done'
         end,
         attempts = case
           when coalesce((payload->>'turnSeq')::bigint, 0) > $2 then 0
           else attempts
         end,
         last_error = case
           when coalesce((payload->>'turnSeq')::bigint, 0) > $2 then null
           else last_error
         end,
         locked_until = null,
         run_after = $3,
         updated_at = $3
     where id = $1
     returning status`,
    [id, ranSeq, ts],
  );
  return rows[0]?.status === "pending" ? "pending" : "done";
}

export async function cleanupOldJobs(now: number): Promise<void> {
  const db = await getSql();
  await db.query(`delete from brain_jobs where status = 'done' and updated_at < $1`, [now - 14 * 86_400_000]);
}

export async function appendBrainLog(row: {
  jobId?: string | null;
  step: string;
  ok: boolean;
  ms?: number | null;
  inputChars?: number | null;
  raw?: string | null;
  note?: string | null;
  route?: string | null;
  model?: string | null;
  effort?: string | null;
  turnSeq?: number | null;
  inputSystem?: string | null;
  inputUser?: string | null;
  outputText?: string | null;
  tokensIn?: number | null;
  tokensCached?: number | null;
  tokensOut?: number | null;
  tokensReasoning?: number | null;
  costUsd?: number | null;
  costUsdEst?: number | null;
  error?: string | null;
  codeVersion?: string | null;
  refs?: unknown;
  outputRef?: string | null;
  promptKey?: string | null;
  promptHash?: string | null;
  trimmed?: boolean;
}): Promise<number | null> {
  try {
    const clipped = clipLogRecord({
      inputSystem: row.inputSystem,
      inputUser: row.inputUser,
      outputText: row.outputText,
    });
    const db = await getSql();
    const rows = await db.query<{ id: number }>(
      `insert into brain_log (
         job_id, step, ok, ms, input_chars, raw, note, at,
         route, model, effort, turn_seq, input_system, input_user, output_text,
         tokens_in, tokens_cached, tokens_out, tokens_reasoning, cost_usd, error, trimmed,
         code_version, refs, output_ref, cost_usd_est, prompt_key, prompt_hash
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
         $23,$24::jsonb,$25,$26,$27,$28
       ) returning id`,
      [
        row.jobId ?? null,
        row.step,
        row.ok,
        row.ms ?? null,
        row.inputChars ?? null,
        (row.raw ?? "").slice(0, 4000),
        row.note ?? null,
        now(),
        row.route ?? null,
        row.model ?? null,
        row.effort ?? null,
        row.turnSeq ?? null,
        clipped.inputSystem,
        clipped.inputUser,
        clipped.outputText,
        row.tokensIn ?? null,
        row.tokensCached ?? null,
        row.tokensOut ?? null,
        row.tokensReasoning ?? null,
        row.costUsd ?? null,
        row.error ?? null,
        Boolean(row.trimmed) || clipped.truncated,
        row.codeVersion ?? null,
        row.refs == null ? null : JSON.stringify(row.refs),
        row.outputRef ?? null,
        row.costUsdEst ?? null,
        row.promptKey ?? null,
        row.promptHash ?? null,
      ],
    );
    return rows[0]?.id != null ? asInt(rows[0].id) : null;
  } catch {
    /* logging must never break talk */
    return null;
  }
}

export async function patchBrainLog(
  id: number | null | undefined,
  patch: { outputText?: string | null; outputRef?: string | null; note?: string | null },
): Promise<void> {
  if (!id) return;
  try {
    const db = await getSql();
    const sets: string[] = [];
    const params: unknown[] = [id];
    if ("outputText" in patch) {
      params.push(patch.outputText ?? null);
      sets.push(`output_text = $${params.length}`);
    }
    if ("outputRef" in patch) {
      params.push(patch.outputRef ?? null);
      sets.push(`output_ref = $${params.length}`);
    }
    if ("note" in patch && patch.note) {
      params.push(patch.note);
      sets.push(
        `note = case when coalesce(note, '') = '' then $${params.length} else note || E'\\n' || $${params.length} end`,
      );
    }
    if (!sets.length) return;
    await db.query(`update brain_log set ${sets.join(", ")} where id = $1`, params);
  } catch {
    /* ignore */
  }
}

export type VoiceModelStats = {
  model: string;
  n: number;
  avgMs: number | null;
  avgTtftMs: number | null;
  emptyRate: number | null;
};

function meanNums(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function parseLogTtftMs(note: string | null): number | null {
  if (!note) return null;
  const m = note.match(/ttft_ms=(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function isEmptyVoiceLog(row: { ok: boolean; note: string | null; error: string | null }): boolean {
  if (row.ok) return false;
  return /空回复|\bempty\b/.test(`${row.note ?? ""}\n${row.error ?? ""}`);
}

export async function voiceModelStatsLast7d(): Promise<VoiceModelStats[]> {
  const db = await getSql();
  const since = now() - 90 * 86_400_000;
  const rows = await db.query<{
    model: string | null;
    ms: unknown;
    ok: unknown;
    note: string | null;
    error: string | null;
  }>(`select model, ms, ok, note, error from brain_log where route = $1 and at >= $2`, ["voice", since]);
  const by = new Map<string, { n: number; ms: number[]; ttft: number[]; empty: number }>();
  for (const row of rows) {
    const model = (row.model ?? "").trim();
    if (!model) continue;
    let g = by.get(model);
    if (!g) {
      g = { n: 0, ms: [], ttft: [], empty: 0 };
      by.set(model, g);
    }
    g.n += 1;
    const ms = asIntOrNull(row.ms);
    if (ms != null) g.ms.push(ms);
    const ttft = parseLogTtftMs(row.note);
    if (ttft != null) g.ttft.push(ttft);
    if (isEmptyVoiceLog({ ok: asBool(row.ok), note: row.note, error: row.error })) g.empty += 1;
  }
  return [...by.entries()]
    .map(([model, g]) => ({
      model,
      n: g.n,
      avgMs: meanNums(g.ms),
      avgTtftMs: meanNums(g.ttft),
      emptyRate: g.n ? g.empty / g.n : null,
    }))
    .sort((a, b) => b.n - a.n || a.model.localeCompare(b.model));
}

export type BrainLogFilter = {
  route?: string | null;
  from?: number | null;
  to?: number | null;
};

export async function listBrainLog(limit = 50, filter?: BrainLogFilter): Promise<BrainLogRow[]> {
  const db = await getSql();
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter?.route) {
    params.push(filter.route);
    where.push(`(route = $${params.length} or step = $${params.length} or step like $${params.length} || ':%')`);
  }
  if (filter?.from != null) {
    params.push(filter.from);
    where.push(`at >= $${params.length}`);
  }
  if (filter?.to != null) {
    params.push(filter.to);
    where.push(`at <= $${params.length}`);
  }
  params.push(limit);
  const rows = await db.query<Record<string, unknown>>(
    `select id, job_id, step, ok, ms, input_chars,
            left(raw, 300) as raw, note, at, route, model, effort, turn_seq,
            tokens_in, tokens_cached, tokens_out, tokens_reasoning, cost_usd, error, trimmed,
            prompt_key, prompt_hash, left(output_text, 300) as output_text
     from brain_log
     ${where.length ? `where ${where.join(" and ")}` : ""}
     order by at desc, id desc
     limit $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: asInt(r.id),
    jobId: r.job_id ? String(r.job_id) : null,
    step: String(r.step),
    ok: asBool(r.ok),
    ms: asIntOrNull(r.ms),
    inputChars: asIntOrNull(r.input_chars),
    raw: r.raw ? String(r.raw) : null,
    note: r.note ? String(r.note) : null,
    at: asInt(r.at),
    route: r.route ? String(r.route) : null,
    model: r.model ? String(r.model) : null,
    effort: r.effort ? String(r.effort) : null,
    turnSeq: asIntOrNull(r.turn_seq),
    tokensIn: asIntOrNull(r.tokens_in),
    tokensCached: asIntOrNull(r.tokens_cached),
    tokensOut: asIntOrNull(r.tokens_out),
    tokensReasoning: asIntOrNull(r.tokens_reasoning),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    error: r.error ? String(r.error) : null,
    trimmed: asBool(r.trimmed),
    promptKey: r.prompt_key ? String(r.prompt_key) : null,
    promptHash: r.prompt_hash ? String(r.prompt_hash) : null,
    outputText: r.output_text ? String(r.output_text) : null,
    inputSystem: r.input_system ? String(r.input_system) : null,
    inputUser: r.input_user ? String(r.input_user) : null,
  }));
}

export async function getProfileData(): Promise<unknown> {
  const db = await getSql();
  const rows = await db.query<{ data: unknown }>("select data from qingran_profile where id = 1");
  return rows[0]?.data ?? {};
}

export async function getProfilePrompt(): Promise<string> {
  const data = asJson<Record<string, unknown>>(await getProfileData(), {});
  const direct = storedSystemPrompt(data);
  if (direct) return direct;
  await warnPersonaMissing();
  return NEUTRAL_PERSONA;
}

async function warnPersonaMissing(): Promise<void> {
  try {
    await appendBrainLog({
      step: "persona_missing",
      ok: false,
      note: "persona_missing",
      error: "persona_missing",
    });
  } catch (err) {
    console.error("[persona] missing", err);
  }
}

export { SESSION_GAP_MS, newId };

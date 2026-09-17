import { now } from "../clock.ts";
import { getSql } from "../../../db.ts";
import {
  getDay,
  getMeta,
  listDayFactors,
  listEpisodes,
  listFactors,
  listIntentions,
  listPortrait,
  notesForDay,
} from "../store.ts";
import { isoWeek } from "../time.ts";

export type DailyDigestData = {
  day: string;
  messages: { count: number; sessions: number; firstActive: number | null; lastActive: number | null };
  notes: {
    added: Array<{ id: string; text: string; status: string }>;
    superseded: Array<{ oldId: string; newId: string; text: string }>;
    edits: number;
  };
  diary: {
    summary: string;
    coverage: string;
    factors: Record<string, number | null>;
    intentions: Array<{ id: string; status: string; text: string }>;
    episodes: Array<{ factor: string; startDay: string; endDay: string | null }>;
  };
  qingran: {
    portrait: Array<{ topic: string; body: string }>;
    self: string;
    bond: string;
    mindCount: number;
    lastLeadPlan: string[];
  };
  system: {
    jobs: Array<{ type: string; status: string; ms: number | null; error: string | null }>;
    routes: Record<string, { n: number; tokensIn: number; tokensOut: number; tokensCached: number; cost: number; timeouts: number }>;
    hot: { packP50: number | null; ttftP50: number | null; ttftP95: number | null; staleRate: number; avgMemories: number };
  };
};

function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? null;
}

function md(data: DailyDigestData): string {
  const lines: string[] = [];
  lines.push(`# ${data.day}`);
  lines.push("");
  lines.push(`## 对话`);
  lines.push(`消息 ${data.messages.count} 条，会话 ${data.messages.sessions} 个。`);
  lines.push("");
  lines.push(`## 记忆库`);
  if (!data.notes.added.length) lines.push("当天没有新笔记。");
  for (const n of data.notes.added) lines.push(`- （${n.status}）${n.text}`);
  if (data.notes.superseded.length) {
    lines.push("");
    lines.push("被替换：");
    for (const s of data.notes.superseded) lines.push(`- ${s.oldId} → ${s.newId}：${s.text}`);
  }
  lines.push("");
  lines.push(`## 日记`);
  lines.push(`覆盖 ${data.diary.coverage}。${data.diary.summary || "（无摘要）"}`);
  const factorLine = Object.entries(data.diary.factors)
    .map(([k, v]) => `${k}=${v ?? "?"}`)
    .join("  ");
  if (factorLine) lines.push(factorLine);
  for (const i of data.diary.intentions) lines.push(`- [${i.status}] ${i.text}`);
  lines.push("");
  lines.push(`## 清然`);
  if (data.qingran.self) lines.push(`自己：${data.qingran.self}`);
  if (data.qingran.bond) lines.push(`我们：${data.qingran.bond}`);
  if (data.qingran.lastLeadPlan.length) lines.push(`带她：${data.qingran.lastLeadPlan.join(" → ")}`);
  lines.push("");
  lines.push(`## 系统`);
  const cost = Object.values(data.system.routes).reduce((s, r) => s + r.cost, 0);
  const calls = Object.values(data.system.routes).reduce((s, r) => s + r.n, 0);
  lines.push(`模型调用 ${calls} 次，估算 $${cost.toFixed(4)}。`);
  const reflect = data.system.routes.reflect;
  if (reflect && reflect.n) {
    const hit = reflect.tokensIn ? reflect.tokensCached / reflect.tokensIn : 0;
    lines.push(
      `Reflector 缓存命中 ${(hit * 100).toFixed(0)}%，平均每轮 $${(reflect.cost / reflect.n).toFixed(4)}。`,
    );
  }
  if (data.system.hot.ttftP50 != null) lines.push(`TTFT p50 ${data.system.hot.ttftP50}ms / p95 ${data.system.hot.ttftP95}ms。`);
  return lines.join("\n");
}

export async function writeDailyDigest(day: string): Promise<void> {
  const db = await getSql();
  const log = await getDay(day);
  const notes = await notesForDay(day, true);
  const factors = await listFactors(true);
  const dayFactors = (await listDayFactors(day, day)).filter((d) => d.day === day);
  const factorName = new Map(factors.map((f) => [f.id, f.name]));
  const episodes = (await listEpisodes()).filter(
    (e) => e.startDay <= day && (e.endDay ?? e.startDay) >= day,
  );
  const intentions = await listIntentions();
  const portrait = await listPortrait();
  const meta = await getMeta();

  const msgs = await db.query<{ n: number; sessions: number }>(
    `select count(*)::int as n, count(distinct session_id)::int as sessions
     from qingran_messages where local_day = $1`,
    [day],
  );
  const hist = await db.query<{ n: number }>(
    `select count(*)::int as n from mem_history
     where op = 'MANUAL_EDIT' and to_char(to_timestamp(at / 1000.0), 'YYYY-MM-DD') = $1`,
    [day],
  );
  const supers = await db.query<{ old_id: string; new_id: string; text: string }>(
    `select h.row_id as old_id, coalesce(h.after->>'supersededBy', '') as new_id,
            coalesce(h.before->>'text', '') as text
     from mem_history h
     where h.op = 'SUPERSEDE' and h.table_name = 'mem_notes'
       and exists (select 1 from mem_notes n where n.id = h.row_id and n.local_day = $1)`,
    [day],
  );
  const jobs = await db.query<{
    type: string;
    status: string;
    last_error: string | null;
    created_at: number;
    updated_at: number;
  }>(
    `select type, status, last_error, created_at, updated_at from brain_jobs
     where dedupe_key like '%' || $1 || '%' or to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') = $1
     order by created_at`,
    [day],
  );
  const logs = await db.query<{
    route: string | null;
    step: string;
    tokens_in: number | null;
    tokens_out: number | null;
    tokens_cached: number | null;
    cost_usd: number | null;
    error: string | null;
    ok: boolean;
  }>(
    `select route, step, tokens_in, tokens_out, tokens_cached, cost_usd, error, ok from brain_log
     where at >= $1 and at < $2`,
    [
      Date.parse(`${day}T00:00:00Z`) - 12 * 3_600_000,
      Date.parse(`${day}T00:00:00Z`) + 36 * 3_600_000,
    ],
  );
  const turns = await db.query<{
    pack_ms: number | null;
    ttft_ms: number | null;
    mind_stale: boolean;
    picked_ids: unknown;
    fallback_ids: unknown;
  }>(`select pack_ms, ttft_ms, mind_stale, picked_ids, fallback_ids from brain_turns where local_day = $1`, [day]);
  const minds = await db.query<{ n: number; data: unknown }>(
    `select count(*)::int as n from qr_mind_history
     where created_at >= $1 and created_at < $2`,
    [
      Date.parse(`${day}T00:00:00Z`) - 12 * 3_600_000,
      Date.parse(`${day}T00:00:00Z`) + 36 * 3_600_000,
    ],
  );
  const lastMind = await db.query<{ data: unknown }>(
    `select data from qr_mind_history order by turn_seq desc limit 1`,
  );

  const routes: DailyDigestData["system"]["routes"] = {};
  for (const l of logs) {
    const route = l.route || (l.step.split(":")[0] ?? "other");
    routes[route] ??= { n: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, cost: 0, timeouts: 0 };
    routes[route]!.n += 1;
    routes[route]!.tokensIn += Number(l.tokens_in) || 0;
    routes[route]!.tokensOut += Number(l.tokens_out) || 0;
    routes[route]!.tokensCached += Number(l.tokens_cached) || 0;
    routes[route]!.cost += Number(l.cost_usd) || 0;
    if (!l.ok && /timeout/i.test(String(l.error ?? ""))) routes[route]!.timeouts += 1;
  }

  const pack = turns.map((t) => t.pack_ms).filter((n): n is number => n != null);
  const ttft = turns.map((t) => t.ttft_ms).filter((n): n is number => n != null);
  const memCounts = turns.map((t) => {
    const a = Array.isArray(t.picked_ids) ? t.picked_ids.length : 0;
    const b = Array.isArray(t.fallback_ids) ? t.fallback_ids.length : 0;
    return a + b;
  });
  const lastLead =
    lastMind[0]?.data && typeof lastMind[0].data === "object"
      ? ((lastMind[0].data as { lead_plan?: string[] }).lead_plan ?? [])
      : [];

  const data: DailyDigestData = {
    day,
    messages: {
      count: Number(msgs[0]?.n) || 0,
      sessions: Number(msgs[0]?.sessions) || 0,
      firstActive: log?.firstActive ?? null,
      lastActive: log?.lastActive ?? null,
    },
    notes: {
      added: notes.map((n) => ({ id: n.id, text: n.text, status: n.status })),
      superseded: supers.map((s) => ({ oldId: s.old_id, newId: s.new_id, text: s.text })),
      edits: Number(hist[0]?.n) || 0,
    },
    diary: {
      summary: log?.summary ?? "",
      coverage: log?.coverage ?? "none",
      factors: Object.fromEntries(
        dayFactors.map((d) => [factorName.get(d.factorId) ?? d.factorId, d.value]),
      ),
      intentions: intentions
        .filter((i) => i.statedAt && isoWeek(day))
        .slice(0, 20)
        .map((i) => ({ id: i.id, status: i.status, text: i.text })),
      episodes: episodes.map((e) => ({
        factor: factorName.get(e.factorId) ?? e.factorId,
        startDay: e.startDay,
        endDay: e.endDay,
      })),
    },
    qingran: {
      portrait: portrait.filter((p) => p.status === "active").map((p) => ({ topic: p.topic, body: p.body })),
      self: meta.selfSummary,
      bond: meta.bondSummary,
      mindCount: Number(minds[0]?.n) || 0,
      lastLeadPlan: Array.isArray(lastLead) ? lastLead : [],
    },
    system: {
      jobs: jobs.map((j) => ({
        type: j.type,
        status: j.status,
        ms: j.updated_at && j.created_at ? Number(j.updated_at) - Number(j.created_at) : null,
        error: j.last_error,
      })),
      routes,
      hot: {
        packP50: pct(pack, 0.5),
        ttftP50: pct(ttft, 0.5),
        ttftP95: pct(ttft, 0.95),
        staleRate: turns.length ? turns.filter((t) => t.mind_stale).length / turns.length : 0,
        avgMemories: memCounts.length ? memCounts.reduce((a, b) => a + b, 0) / memCounts.length : 0,
      },
    },
  };

  const markdown = md(data);
  const ts = now();
  await db.query(
    `insert into brain_daily_digest (day, data, markdown, updated_at)
     values ($1, $2::jsonb, $3, $4)
     on conflict (day) do update set data = excluded.data, markdown = excluded.markdown, updated_at = excluded.updated_at`,
    [day, JSON.stringify(data), markdown, ts],
  );
}

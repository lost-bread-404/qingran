/**
 * Read an exported JSONL (from Diary 系统档案) and write out/usage-report.md.
 *   npm run analyze -- path/to/export.jsonl
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type JsonlRow = { table?: string; [k: string]: unknown };

export function parseJsonl(text: string): JsonlRow[] {
  const rows: JsonlRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as JsonlRow);
    } catch {
      /* skip */
    }
  }
  return rows;
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function buildUsageReport(rows: JsonlRow[]): string {
  const turns = rows.filter((r) => r.table === "brain_turns");
  const logs = rows.filter((r) => r.table === "brain_log");
  const notesHist = rows.filter((r) => r.table === "mem_history");
  const lines: string[] = [];
  lines.push("# 清然用量报告");
  lines.push("");

  const pack = turns.map((t) => num(t.pack_ms)).filter((n): n is number => n != null);
  const dbFirst = turns.map((t) => num(t.db_first_ms)).filter((n): n is number => n != null);
  const ttft = turns.map((t) => num(t.ttft_ms)).filter((n): n is number => n != null);
  const audio = turns.map((t) => num(t.first_audio_ms)).filter((n): n is number => n != null);
  lines.push("## 延迟");
  lines.push(`- pack p50 ${pct(pack, 0.5)} / p95 ${pct(pack, 0.95)}`);
  lines.push(`- db_first p50 ${pct(dbFirst, 0.5)} / p95 ${pct(dbFirst, 0.95)}`);
  lines.push(`- TTFT p50 ${pct(ttft, 0.5)} / p95 ${pct(ttft, 0.95)}`);
  lines.push(`- first_audio p50 ${pct(audio, 0.5)} / p95 ${pct(audio, 0.95)}`);
  lines.push("");

  const reflect = turns.filter((t) => t.reflect_ok != null);
  const timeouts = logs.filter((l) => String(l.error ?? l.note ?? "").includes("timeout"));
  const stale = turns.filter((t) => t.mind_stale === true || t.mind_stale === "t");
  lines.push("## Reflector");
  lines.push(`- 成功率 ${reflect.length ? reflect.filter((t) => t.reflect_ok === true || t.reflect_ok === "t").length / reflect.length : 0}`);
  lines.push(`- 超时次数 ${timeouts.length}`);
  lines.push(`- stale mind 比例 ${turns.length ? stale.length / turns.length : 0}`);
  lines.push("");

  const memCounts = turns.map((t) => {
    const p = Array.isArray(t.picked_ids) ? t.picked_ids.length : 0;
    const f = Array.isArray(t.fallback_ids) ? t.fallback_ids.length : 0;
    return { p, f, n: p + f };
  });
  const freq = new Map<string, number>();
  for (const t of turns) {
    for (const id of [...(Array.isArray(t.picked_ids) ? t.picked_ids : []), ...(Array.isArray(t.fallback_ids) ? t.fallback_ids : [])]) {
      freq.set(String(id), (freq.get(String(id)) ?? 0) + 1);
    }
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  lines.push("## 记忆");
  lines.push(`- 每轮平均注入 ${memCounts.length ? memCounts.reduce((s, x) => s + x.n, 0) / memCounts.length : 0}`);
  lines.push(`- picked/fallback ${memCounts.reduce((s, x) => s + x.p, 0)} / ${memCounts.reduce((s, x) => s + x.f, 0)}`);
  lines.push("- 被注入最多的笔记：");
  for (const [id, n] of top) lines.push(`  - ${id} × ${n}`);
  lines.push("");

  const byRoute = new Map<string, { n: number; tin: number; tout: number; cached: number; cost: number }>();
  const byModel = new Map<string, { n: number; cost: number }>();
  for (const l of logs) {
    const route = String(l.route ?? String(l.step ?? "").split(":")[0] ?? "other");
    const model = String(l.model ?? "");
    const rec = byRoute.get(route) ?? { n: 0, tin: 0, tout: 0, cached: 0, cost: 0 };
    rec.n += 1;
    rec.tin += num(l.tokens_in) ?? 0;
    rec.tout += num(l.tokens_out) ?? 0;
    rec.cached += num(l.tokens_cached) ?? 0;
    rec.cost += num(l.cost_usd) ?? 0;
    byRoute.set(route, rec);
    if (model) {
      const m = byModel.get(model) ?? { n: 0, cost: 0 };
      m.n += 1;
      m.cost += num(l.cost_usd) ?? 0;
      byModel.set(model, m);
    }
  }
  lines.push("## 成本");
  for (const [route, r] of [...byRoute.entries()].sort()) {
    const hit = r.tin ? r.cached / r.tin : 0;
    const avg = r.n ? r.cost / r.n : 0;
    lines.push(
      `- ${route}: ${r.n} 次, in ${r.tin}, cached ${r.cached}, 命中率 ${hit.toFixed(2)}, out ${r.tout}, $${r.cost.toFixed(4)}, 每轮 $${avg.toFixed(4)}`,
    );
  }
  for (const [model, r] of [...byModel.entries()].sort()) {
    lines.push(`- 模型 ${model}: ${r.n} 次, $${r.cost.toFixed(4)}`);
  }
  const byDay = new Map<string, { n: number; cost: number; tin: number; cached: number }>();
  for (const l of logs) {
    const at = num(l.at);
    const day = at != null ? new Date(at).toISOString().slice(0, 10) : "unknown";
    const rec = byDay.get(day) ?? { n: 0, cost: 0, tin: 0, cached: 0 };
    rec.n += 1;
    rec.cost += num(l.cost_usd) ?? 0;
    rec.tin += num(l.tokens_in) ?? 0;
    rec.cached += num(l.tokens_cached) ?? 0;
    byDay.set(day, rec);
  }
  if (byDay.size) {
    lines.push("- 按天：");
    for (const [day, r] of [...byDay.entries()].sort()) {
      const hit = r.tin ? r.cached / r.tin : 0;
      lines.push(`  - ${day}: ${r.n} 次, 命中率 ${hit.toFixed(2)}, $${r.cost.toFixed(4)}`);
    }
  }
  lines.push("");

  const added = notesHist.filter((h) => h.op === "ADD").length;
  const sup = notesHist.filter((h) => h.op === "SUPERSEDE").length;
  lines.push("## 记忆库增长");
  lines.push(`- 新增 ${added}，替换 ${sup}`);
  lines.push("");

  lines.push("## 错误 Top 10");
  const err = new Map<string, number>();
  for (const l of logs) {
    if (l.ok === true || l.ok === "t") continue;
    const key = `${l.route ?? l.step}:${l.error ?? l.note ?? "fail"}`;
    err.set(key, (err.get(key) ?? 0) + 1);
  }
  for (const [k, n] of [...err.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    lines.push(`- ${k} × ${n}`);
  }
  if (!err.size) lines.push("- （没有失败记录）");
  lines.push("");

  const costDays = new Map<string, number>();
  for (const l of logs) {
    const at = num(l.at);
    const day = at != null ? new Date(at).toISOString().slice(0, 10) : String(l.day ?? "unknown");
    costDays.set(day, (costDays.get(day) ?? 0) + (num(l.cost_usd) ?? 0));
  }
  const monthKeys = [...costDays.keys()].filter((d) => d.length >= 7);
  const thisMonth = monthKeys.sort().at(-1)?.slice(0, 7);
  if (thisMonth) {
    const days = [...costDays.entries()].filter(([d]) => d.startsWith(thisMonth));
    const spent = days.reduce((s, [, v]) => s + v, 0);
    const n = days.length || 1;
    const dim = 30;
    lines.push("## 费用预测");
    lines.push(`- ${thisMonth} 已花 $${spent.toFixed(4)}，按 ${n} 天外推全月 $${((spent / n) * dim).toFixed(2)}`);
    lines.push("");
  }

  const alerts = rows.filter((r) => r.table === "spend_alerts");
  lines.push("## 警报");
  if (!alerts.length) lines.push("- （没有警报记录）");
  for (const a of alerts) lines.push(`- ${a.level} ${a.scope} ${a.detail ?? ""}`);
  lines.push("");

  const good = turns.filter((t) => t.feedback === "good");
  const bad = turns.filter((t) => t.feedback === "bad");
  if (good.length || bad.length) {
    const avg = (xs: JsonlRow[], key: string) => {
      const vs = xs.map((x) => num(x[key])).filter((n): n is number => n != null);
      return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
    };
    lines.push("## 反馈对比");
    lines.push(`- good ${good.length}：tail 长度 ${avg(good, "tail") ? String((good[0]?.tail as string | undefined)?.length ?? 0) : 0}`);
    lines.push(`- bad ${bad.length}`);
  }
  return lines.join("\n");
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("usage-report.ts")) {
  const file = process.argv.slice(2).find((a) => a && a !== "--");
  if (!file) {
    console.error("usage: usage-report.ts <export.jsonl>");
    process.exit(1);
  }
  const text = readFileSync(resolve(file), "utf8");
  const md = buildUsageReport(parseJsonl(text));
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "../../out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "usage-report.md"), md);
  console.log(md);
}


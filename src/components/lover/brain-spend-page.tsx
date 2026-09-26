import { useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { brainGetCallLog, brainGetTurnTrace } from "@/lib/lover/brain/api";
import {
  brainArchiveOldSpend,
  brainExportSpendCsv,
  brainGetSpendOverview,
  brainListSpendEvents,
  brainSpendReconcile,
  type SpendEventRow,
} from "@/lib/lover/brain/spend/api";
import { routePriority } from "@/lib/lover/brain/spend/policy";
import { SuperGrokPanel } from "@/components/lover/supergrok-panel";
import { cn } from "@/lib/utils";

function asNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function band(route: string): "P0" | "P1" | "P2" | "P3" {
  const p = routePriority(route);
  return (`P${p}` as "P0" | "P1" | "P2" | "P3");
}

export function BrainSpendPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof brainGetSpendOverview>> | null>(null);
  const [events, setEvents] = useState<SpendEventRow[]>([]);
  const [dayFilter, setDayFilter] = useState("");
  const [routeFilter, setRouteFilter] = useState("");
  const [actual, setActual] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [range, setRange] = useState<30 | 90>(30);
  const [err, setErr] = useState<string | null>(null);
  const [call, setCall] = useState<Record<string, unknown> | null>(null);
  const [trace, setTrace] = useState<unknown>(null);

  async function refresh() {
    const o = await brainGetSpendOverview();
    setData(o);
    setDayFilter(o.day);
  }

  useEffect(() => {
    void refresh().catch(() => setErr("费用这会儿读不出来。"));
  }, []);

  useEffect(() => {
    void brainListSpendEvents({ data: { day: dayFilter || undefined, route: routeFilter || undefined } }).then(
      setEvents,
    );
  }, [dayFilter, routeFilter]);

  const byDay = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, { day: string; P0: number; P1: number; P2: number; P3: number }>();
    for (const r of data.daily) {
      const row = map.get(r.day) ?? { day: r.day, P0: 0, P1: 0, P2: 0, P3: 0 };
      row[band(r.route)] += asNum(r.usd);
      map.set(r.day, row);
    }
    return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
  }, [data]);

  const stacked = useMemo(() => byDay.slice(-range), [byDay, range]);

  const monthCurve = useMemo(() => {
    if (!data) return [];
    let cum = 0;
    return byDay
      .filter((r) => r.day.startsWith(data.month))
      .map((r) => {
        cum += r.P0 + r.P1 + r.P2 + r.P3;
        return { day: r.day, cum };
      });
  }, [data, byDay]);

  if (err) return <p className="text-sm text-live">{err}</p>;
  if (!data) return <p className="text-sm text-subtle">在算今天花了多少…</p>;

  return (
    <section className="flex flex-col gap-6">
      <SuperGrokPanel />
      <div className="rounded-xl bg-surface p-4 text-sm leading-relaxed">
        <p>
          今天 ${data.dayUsd.toFixed(3)} · 本月 ${data.monthUsd.toFixed(3)} · 预测 ${data.forecast.toFixed(2)}
        </p>
      </div>

      <div>
        <div className="mb-2 flex gap-2">
          <Button size="sm" variant={range === 30 ? "default" : "ghost"} onClick={() => setRange(30)}>
            30 天
          </Button>
          <Button size="sm" variant={range === 90 ? "default" : "ghost"} onClick={() => setRange(90)}>
            90 天
          </Button>
        </div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={stacked}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line, #ddd)" />
              <XAxis dataKey="day" tickFormatter={(v: string) => v.slice(5)} fontSize={10} />
              <YAxis fontSize={10} />
              <Tooltip />
              <Area type="monotone" dataKey="P0" stackId="s" fill="#6b4f3a" stroke="none" />
              <Area type="monotone" dataKey="P1" stackId="s" fill="#a67c52" stroke="none" />
              <Area type="monotone" dataKey="P2" stackId="s" fill="#c9b49a" stroke="none" />
              <Area type="monotone" dataKey="P3" stackId="s" fill="#e8dfd4" stroke="none" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mb-2 mt-4 text-xs text-subtle">本月累计</p>
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={monthCurve}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line, #ddd)" />
              <XAxis dataKey="day" tickFormatter={(v: string) => v.slice(8)} fontSize={10} />
              <YAxis fontSize={10} />
              <Tooltip />
              <Line type="monotone" dataKey="cum" stroke="#2c241c" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="text-sm">
        <p className="mb-2 text-xs text-subtle">本月分解 · 每轮对话均 ${data.avgTurn.toFixed(4)}</p>
        <p className="mb-2 text-xs text-subtle">
          xAI 实际金额合计 ${asNum(data.xaiUsd).toFixed(4)} · 占比 {(asNum(data.xaiShare) * 100).toFixed(0)}%
        </p>
        <ul className="flex flex-col gap-1">
          {data.monthEvents.map((r, i) => (
            <li key={`${r.route}-${r.model}-${i}`} className="flex justify-between gap-3">
              <span>
                {r.route} {r.model ? `· ${r.model}` : ""}
              </span>
              <span className="text-subtle">
                {r.n} 次 · ${asNum(r.usd).toFixed(4)} · 均 ${r.n ? (asNum(r.usd) / r.n).toFixed(4) : "0"}
              </span>
            </li>
          ))}
        </ul>
        {Array.isArray(data.routeDeviation) && data.routeDeviation.length ? (
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {data.routeDeviation.map((r) => (
              <li key={r.route} className={r.deviation > 0.1 ? "text-live" : "text-subtle"}>
                {r.route} 实际 ${r.usd.toFixed(4)} / 估算 ${r.usdEst.toFixed(4)}
                {r.deviation > 0.1 ? " · 偏差超过 10%，请检查价格表" : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div>
        <p className="mb-2 text-xs text-subtle">当天最贵的 10 次</p>
        <ul className="flex flex-col gap-1 text-xs">
          {data.top.map((r) => (
            <li key={r.id} className="flex justify-between gap-3">
              <button
                type="button"
                className="text-left"
                onClick={() => {
                  if (r.log_id) {
                    void brainGetCallLog({ data: { id: r.log_id } }).then((row) =>
                      setCall(row && typeof row === "object" ? (row as Record<string, unknown>) : null),
                    );
                  }
                  if (r.turn_seq) {
                    void brainGetTurnTrace({ data: { turnSeq: r.turn_seq } }).then(setTrace);
                  }
                }}
              >
                {r.route} {r.model ?? ""}
                {r.log_id ? ` · log ${r.log_id}` : ""}
                {r.turn_seq ? ` · turn ${r.turn_seq}` : ""}
              </button>
              <span>${r.usd.toFixed(4)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input value={dayFilter} onChange={(e) => setDayFilter(e.target.value)} placeholder="日期" className="w-36" />
        <Input value={routeFilter} onChange={(e) => setRouteFilter(e.target.value)} placeholder="route" className="w-28" />
      </div>
      <ul className="flex flex-col gap-1 text-xs">
        {events.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className={cn("w-full rounded-lg bg-surface-2 px-3 py-2 text-left")}
              onClick={() => {
                if (e.log_id) {
                  void brainGetCallLog({ data: { id: e.log_id } }).then((row) =>
                    setCall(row && typeof row === "object" ? (row as Record<string, unknown>) : null),
                  );
                }
                if (e.turn_seq) {
                  void brainGetTurnTrace({ data: { turnSeq: e.turn_seq } }).then(setTrace);
                }
              }}
            >
              {e.day} {e.route} ${e.usd.toFixed(4)}
              {e.turn_seq ? ` · turn ${e.turn_seq}` : ""}
              {e.log_id ? ` · log ${e.log_id}` : ""}
              {e.estimated ? " · 估算" : ""}
            </button>
          </li>
        ))}
      </ul>
      {call ? (
        <pre className="overflow-x-auto rounded-xl bg-surface p-3 text-xs leading-relaxed">
          {JSON.stringify(
            {
              id: call.id,
              route: call.route,
              model: call.model,
              tokens_in: call.tokens_in,
              tokens_out: call.tokens_out,
              cost_usd: call.cost_usd,
              error: call.error,
            },
            null,
            2,
          )}
        </pre>
      ) : null}
      {trace && typeof trace === "object" ? (
        <pre className="overflow-x-auto rounded-xl bg-surface p-3 text-xs leading-relaxed">
          {JSON.stringify(trace, null, 2).slice(0, 2000)}
        </pre>
      ) : null}


      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void brainExportSpendCsv({ data: { month: data.month } }).then((r) => {
              const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `qingran-spend-${r.month}.csv`;
              a.click();
              URL.revokeObjectURL(url);
            })
          }
        >
          导出本月 CSV
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void brainArchiveOldSpend().then((r) => setNote(`归档了 ${r.deleted} 条一年前的明细。`))
          }
        >
          归档 12 个月前明细
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs text-subtle">对账 · 输入 xAI 控制台本月实际金额</p>
        <p className="text-xs text-subtle">xAI 实际金额合计 ${asNum(data.xaiUsd).toFixed(4)}</p>
        <Input value={actual} onChange={(e) => setActual(e.target.value)} placeholder="实际美元" />
        <Button
          size="sm"
          onClick={() =>
            void brainSpendReconcile({ data: { month: data.month, actualUsd: Number(actual) } }).then((r) => {
              if (!r.ok) {
                setNote(r.error);
                return;
              }
              const pct = (r.diff * 100).toFixed(1);
              setNote(
                r.diff > 0.1
                  ? `差异 ${pct}%。价格表或 token 统计可能不准，请核对 MODEL_PRICES / VOICE_PRICES。`
                  : `已对账，差异 ${pct}%。`,
              );
              void refresh();
            })
          }
        >
          写入对账
        </Button>
        {data.reconcile.map((r) => (
          <p key={r.month} className="text-xs text-subtle">
            {r.month} 实际 ${r.actual_usd.toFixed(2)} / 估算 ${r.estimated_usd.toFixed(2)}
          </p>
        ))}
      </div>
      {note ? <p className="text-sm">{note}</p> : null}
    </section>
  );
}

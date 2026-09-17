import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  brainExportLogs,
  brainGetCallLog,
  brainGetDigest,
  brainGetDigests,
  brainGetTurnTrace,
} from "@/lib/lover/brain/api";
import { cn } from "@/lib/utils";

type DigestRow = { day: string; markdown: string; data: unknown; updated_at: number };

function asNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function BrainSystemArchive() {
  const [rows, setRows] = useState<DigestRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    digest: { day: string; markdown: string; data: unknown; updated_at: number } | null;
    turns: unknown;
    logs: unknown;
  } | null>(null);
  const [trace, setTrace] = useState<{ turn: unknown; mind: unknown; logs: unknown } | null>(null);
  const [call, setCall] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    void brainGetDigests()
      .then(setRows)
      .catch(() => setError("档案这会儿读不出来。"));
  }, []);

  useEffect(() => {
    if (!open) {
      setDetail(null);
      return;
    }
    void brainGetDigest({ data: { day: open } }).then(setDetail);
  }, [open]);

  const summary = useMemo(() => {
    const last30 = rows.slice(0, 30);
    return last30.map((r) => {
      const data = (r.data ?? {}) as {
        system?: {
          routes?: Record<string, { n?: number; cost?: number; tokensIn?: number; tokensCached?: number }>;
        };
      };
      const routes = data.system?.routes ?? {};
      const cost = Object.values(routes).reduce((s, x) => s + asNum(x.cost), 0);
      const calls = Object.values(routes).reduce((s, x) => s + asNum(x.n), 0);
      const reflect = routes.reflect ?? {};
      const hit = asNum(reflect.tokensIn) ? asNum(reflect.tokensCached) / asNum(reflect.tokensIn) : 0;
      const avg = asNum(reflect.n) ? asNum(reflect.cost) / asNum(reflect.n) : 0;
      return { day: r.day, cost, calls, reflectHit: hit, reflectAvg: avg, reflectN: asNum(reflect.n) };
    });
  }, [rows]);

  async function downloadLogs() {
    setExporting(true);
    try {
      const to = Date.now();
      const from = to - 90 * 86_400_000;
      const lines: string[] = [];
      let table: string | undefined;
      let cursor: string | undefined;
      for (let i = 0; i < 200; i++) {
        const page = await brainExportLogs({
          data: { from, to, table, cursor },
        });
        const rows = Array.isArray(page.rows) ? page.rows : [];
        for (const row of rows) {
          const rec = row && typeof row === "object" ? (row as Record<string, unknown>) : { value: row };
          lines.push(JSON.stringify({ table: page.table, ...rec }));
        }
        if (!page.next) break;
        table = page.next.table;
        cursor = page.next.cursor;
      }
      const blob = new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "qingran-logs.jsonl";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  async function downloadMonth(month: string) {
    const md = rows
      .filter((r) => r.day.startsWith(month))
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => r.markdown)
      .join("\n\n---\n\n");
    const blob = new Blob([md || "（这个月还没有档案）"], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qingran-${month}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const months = [...new Set(rows.map((r) => r.day.slice(0, 7)))];

  return (
    <section className="flex flex-col gap-5">
      {error ? <p className="text-sm text-live">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={exporting} onClick={() => void downloadLogs()}>
          {exporting ? "导出中…" : "导出日志"}
        </Button>
        {months.slice(0, 3).map((m) => (
          <Button key={m} size="sm" variant="ghost" onClick={() => downloadMonth(m)}>
            下载 {m}
          </Button>
        ))}
      </div>
      <div className="rounded-xl bg-surface p-4 text-sm">
        <p className="mb-2 text-xs text-subtle">最近 30 天</p>
        {summary.length ? (
          <ul className="flex flex-col gap-1">
            {summary.map((s) => (
              <li key={s.day} className="flex justify-between gap-3">
                <span>{s.day.slice(5)}</span>
                <span className="text-subtle">
                  {s.calls} 次 · ${s.cost.toFixed(3)}
                  {s.reflectN
                    ? ` · 内心缓存 ${(s.reflectHit * 100).toFixed(0)}% · $${s.reflectAvg.toFixed(4)}/轮`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-subtle">还没有系统档案。跑过一次整理今天就会出现。</p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <button
            key={r.day}
            type="button"
            onClick={() => setOpen(open === r.day ? null : r.day)}
            className={cn(
              "rounded-lg px-4 py-3 text-left text-sm",
              open === r.day ? "bg-accent text-accent-fg" : "bg-surface-2",
            )}
          >
            {r.day}
          </button>
        ))}
      </div>
      {detail?.digest ? (
        <article className="whitespace-pre-wrap rounded-xl bg-surface p-4 text-sm leading-relaxed">
          {String(detail.digest.markdown)}
        </article>
      ) : null}
      {Array.isArray(detail?.turns) && detail.turns.length ? (
        <div>
          <p className="mb-2 text-xs text-subtle">这一天的对话</p>
          <ul className="flex flex-col gap-2">
            {(detail.turns as Array<Record<string, unknown>>).map((t) => (
              <li key={String(t.turn_seq)}>
                <button
                  type="button"
                  className="w-full rounded-lg bg-surface-2 px-3 py-2 text-left text-xs"
                  onClick={() => void brainGetTurnTrace({ data: { turnSeq: Number(t.turn_seq) } }).then(setTrace)}
                >
                  #{String(t.turn_seq)} pack {String(t.pack_ms ?? "–")}ms / TTFT {String(t.ttft_ms ?? "–")}ms
                  {t.mind_stale ? " · 过期内心" : ""}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {trace?.turn && typeof trace.turn === "object" ? (
        <pre className="overflow-x-auto rounded-xl bg-surface p-3 text-xs leading-relaxed">
          {JSON.stringify(
            {
              tail: (trace.turn as { tail?: string }).tail,
              mind: (trace.mind as { data?: unknown } | null)?.data,
              picked: (trace.turn as { picked_ids?: string[] }).picked_ids,
              fallback: (trace.turn as { fallback_ids?: string[] }).fallback_ids,
              ms: {
                pack: (trace.turn as { pack_ms?: number }).pack_ms,
                ttft: (trace.turn as { ttft_ms?: number }).ttft_ms,
                total: (trace.turn as { total_ms?: number }).total_ms,
              },
            },
            null,
            2,
          )}
        </pre>
      ) : null}
      {Array.isArray(detail?.logs) && detail.logs.length ? (
        <div>
          <p className="mb-2 text-xs text-subtle">模型调用</p>
          <ul className="flex flex-col gap-1">
            {(detail.logs as Array<Record<string, unknown>>).slice(0, 40).map((l) => (
              <li key={String(l.id)}>
                <button
                  type="button"
                  className="w-full rounded-md bg-surface-2 px-3 py-2 text-left text-xs"
                  onClick={() =>
                    void brainGetCallLog({ data: { id: Number(l.id) } }).then((row) =>
                      setCall(row && typeof row === "object" ? (row as Record<string, unknown>) : null),
                    )
                  }
                >
                  {String(l.route ?? l.step)} · {String(l.model ?? "")} · in {String(l.tokens_in ?? "?")} / out{" "}
                  {String(l.tokens_out ?? "?")} · {String(l.ms ?? "?")}ms
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {call ? (
        <pre className="overflow-x-auto rounded-xl bg-surface p-3 text-xs leading-relaxed">
          {JSON.stringify(
            {
              route: call.route,
              model: call.model,
              system: call.input_system,
              user: call.input_user,
              output: call.output_text ?? call.raw,
              usage: {
                in: call.tokens_in,
                cached: call.tokens_cached,
                out: call.tokens_out,
                reasoning: call.tokens_reasoning,
                cost: call.cost_usd,
              },
            },
            null,
            2,
          )}
        </pre>
      ) : null}
    </section>
  );
}

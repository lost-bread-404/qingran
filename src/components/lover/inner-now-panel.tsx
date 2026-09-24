import { useEffect, useState } from "react";
import { brainGetInnerNow } from "@/lib/lover/brain/dossier-api";
import type { InnerState } from "@/lib/lover/brain/types";

type LogRow = {
  id: number;
  turnSeq: number;
  createdAt: number;
  data: unknown;
  model: string | null;
  ms: number | null;
};

function fmtTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function line(label: string, value: string) {
  return (
    <p>
      <span className="text-subtle">{label}</span>
      {value.trim() || "（空）"}
    </p>
  );
}

export function InnerNowPanel() {
  const [inner, setInner] = useState<InnerState | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void brainGetInnerNow()
      .then((res) => {
        if (cancelled) return;
        setInner(res.inner);
        setLog(res.log as LogRow[]);
      })
      .catch(() => {
        if (!cancelled) setError("没读出来。");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-subtle">只读。回复看不到取舍和计划。清空聊天会清掉心里、想要、取舍和正在做，惦记和计划还留着。</p>
      {error ? <p className="text-sm text-live">{error}</p> : null}
      {!inner ? (
        <p className="text-sm text-subtle">正在读…</p>
      ) : (
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {line("心里：", inner.feel)}
          {line("想要：", inner.want)}
          {line("取舍：", inner.choice)}
          {line("正在做：", inner.now)}
          {line("惦记：", inner.longing)}
          <div className="mt-2">
            <p className="text-subtle">计划：</p>
            {inner.plans.length === 0 ? (
              <p>（没有）</p>
            ) : (
              inner.plans.map((plan) => (
                <p key={plan.id || plan.what}>
                  [{plan.status}] {plan.what}
                  {plan.trigger ? ` · ${plan.trigger}` : ""}
                </p>
              ))
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <p className="text-sm">最近的内心记录</p>
        {log.length === 0 ? (
          <p className="text-sm text-subtle">还没有。</p>
        ) : (
          log.map((row) => (
            <div key={row.id} className="rounded-md bg-surface-2 px-3 py-2">
              <button
                type="button"
                className="min-h-11 w-full text-left text-sm"
                onClick={() => setOpenId((cur) => (cur === row.id ? null : row.id))}
              >
                {fmtTime(row.createdAt)} · 第 {row.turnSeq} 轮
                {row.model ? ` · ${row.model}` : ""}
              </button>
              {openId === row.id ? (
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
                  {JSON.stringify(row.data, null, 2)}
                </pre>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

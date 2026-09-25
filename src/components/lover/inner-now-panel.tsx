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
  const [modes, setModes] = useState<Array<{ at: number; mode: string; until: number | null; why: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void brainGetInnerNow()
      .then((res) => {
        if (cancelled) return;
        setInner(res.inner);
        setLog(res.log as LogRow[]);
        setModes(res.modes ?? []);
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
      <p className="text-xs text-subtle">只读。心思只写他自己的感觉和对你此刻的理解，不替回复决定做什么；沿用到写出新的为止（thought 为空就是沿用），30 分钟不说话就过期。</p>
      {error ? <p className="text-sm text-live">{error}</p> : null}
      {!inner ? (
        <p className="text-sm text-subtle">正在读…</p>
      ) : (
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {line("心里（会放进回复）：", inner.now)}
          {line("场景：", inner.scene)}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <p className="text-sm">戏 / 现实 切换记录</p>
        {modes.length === 0 ? (
          <p className="text-sm text-subtle">还没有。没有决定时，工作日 8–20 点是现实，其余是戏。</p>
        ) : (
          modes.map((row) => (
            <p key={`${row.at}-${row.mode}`} className="text-sm">
              {fmtTime(row.at)} → {row.mode === "real" ? "现实" : "戏"}
              {row.until ? `（到 ${fmtTime(row.until)}）` : ""}
              {row.why ? ` · ${row.why}` : ""}
            </p>
          ))
        )}
      </div>
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

import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { brainGetDiary, brainGetReports, brainJobStatus, brainRunDue, brainRunJobs, brainSetDiary } from "@/lib/lover/brain/api";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type ReportRow = Awaited<ReturnType<typeof brainGetReports>>[number];

export function DiaryPage() {
  const [enabled, setEnabled] = useState(false);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("diary-scroll");
    return () => document.documentElement.classList.remove("diary-scroll");
  }, []);

  async function load() {
    const [flag, rows] = await Promise.all([brainGetDiary(), brainGetReports()]);
    setEnabled(flag.enabled);
    setReports(rows);
  }

  useEffect(() => {
    let alive = true;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    void brainRunDue({ data: { timeZone } })
      .catch(() => undefined)
      .finally(() => {
        if (alive) void load().catch(() => setError("日记这会儿读不出来。"));
      });
    return () => {
      alive = false;
    };
  }, []);

  async function waitJobs() {
    for (let i = 0; i < 40; i += 1) {
      const status = await brainJobStatus();
      if (status.pending + status.running === 0) return;
      setBusy("正在写月报…");
      await sleep(3000);
    }
  }

  async function generate() {
    setError(null);
    setBusy("正在写月报…");
    try {
      await brainRunJobs({ data: { types: ["report"] } });
      await waitJobs();
      await load();
    } catch {
      setError("这次没写出来。");
    } finally {
      setBusy(null);
    }
  }

  async function toggle(next: boolean) {
    setEnabled(next);
    try {
      const saved = await brainSetDiary({ data: { enabled: next } });
      setEnabled(saved.enabled);
    } catch {
      setEnabled(!next);
      setError("开关没记下。");
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-4 py-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-2">
        <Link to="/" className="inline-flex min-h-11 min-w-11 items-center justify-center" aria-label="返回">
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="text-lg">日记</h1>
      </div>
      {!enabled ? <p className="text-sm text-subtle">日记已暂停</p> : null}
      <label className="flex min-h-11 items-center justify-between gap-3 rounded-md bg-surface-2 px-3 py-3">
        <span className="text-sm">每月自动写上个月</span>
        <input type="checkbox" checked={enabled} onChange={(event) => void toggle(event.target.checked)} />
      </label>
      <Button type="button" disabled={Boolean(busy)} onClick={() => void generate()}>
        {busy || "生成本月报告"}
      </Button>
      {error ? <p className="text-sm text-live">{error}</p> : null}
      <div className="flex flex-col gap-2">
        {reports.length === 0 ? <p className="text-sm text-subtle">还没有月报。</p> : null}
        {reports.map((row) => (
          <div key={row.id} className="rounded-md bg-surface-2 px-3 py-2">
            <button
              type="button"
              className="min-h-11 w-full text-left text-sm"
              onClick={() => setOpenId((cur) => (cur === row.id ? null : row.id))}
            >
              {row.id}
              <span className="text-subtle"> · {row.periodStart} 至 {row.periodEnd}</span>
            </button>
            {openId === row.id ? (
              <p className="whitespace-pre-wrap pb-2 text-sm leading-relaxed">{row.narrative || "（空）"}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

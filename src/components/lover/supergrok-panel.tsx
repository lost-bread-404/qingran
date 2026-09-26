import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  brainXaiLoginPoll,
  brainXaiLoginStart,
  brainXaiLoginStatus,
  brainXaiLogout,
} from "@/lib/lover/brain/spend/api";
import type { XaiLoginStatus } from "@/lib/lover/xai-auth";

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** SuperGrok subscription first; when it is used up or refused, the same call goes to the API key. */
export function SuperGrokPanel() {
  const [status, setStatus] = useState<XaiLoginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void brainXaiLoginStatus().then(setStatus).catch(() => setErr("读不到 SuperGrok 的状态。"));
  }, []);

  // While she approves in the browser, ask every few seconds.
  useEffect(() => {
    if (!status?.pending) return;
    const id = window.setInterval(() => {
      void brainXaiLoginPoll().then(setStatus).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(id);
  }, [status?.pending?.userCode]);

  const run = (fn: () => Promise<XaiLoginStatus>) => {
    setBusy(true);
    setErr(null);
    void fn()
      .then(setStatus)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "没成功。"))
      .finally(() => setBusy(false));
  };

  if (!status) return <p className="text-sm text-subtle">{err ?? "在看 SuperGrok…"}</p>;

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-surface p-4 text-sm leading-relaxed">
      <p className="font-medium">先用 SuperGrok 额度</p>
      <p className="text-xs text-subtle">
        连上以后，回复、心思、夜里整理、听写和朗读都先用你 SuperGrok 订阅的额度；额度用完或被拒，同一个请求自动改走 xAI API（按量付费），过一阵再试订阅。走订阅的记录在这里记 $0。
      </p>
      {status.connected ? (
        <p>
          {status.refusedUntil
            ? `已连接 · 这会儿在用 API，${clock(status.refusedUntil)} 再试订阅`
            : "已连接 · 正在用订阅额度"}
        </p>
      ) : status.pending ? (
        <p>
          打开{" "}
          <a className="underline underline-offset-4" href={status.pending.url} target="_blank" rel="noreferrer">
            这个链接
          </a>
          ，用有 SuperGrok 的账号登录并同意；要填码就填 <span className="font-mono">{status.pending.userCode}</span>。同意后这里会自己变成「已连接」。
        </p>
      ) : (
        <p>{status.hasApiKey ? "没连接 · 现在全部走 API" : "没连接，也没有 API key"}</p>
      )}
      {status.note ? <p className="text-xs text-subtle">上一次：{status.note}</p> : null}
      {err ? <p className="text-xs text-live">{err}</p> : null}
      <div className="flex gap-2">
        {status.connected ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => brainXaiLogout())}>
            断开
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => run(() => brainXaiLoginStart())}>
            {status.pending ? "重新开始" : "连接 SuperGrok"}
          </Button>
        )}
      </div>
    </div>
  );
}

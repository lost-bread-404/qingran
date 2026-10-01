import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { brainGetLife, brainListManualEdits, brainSetReach, brainTestPush, brainWakeNow } from "@/lib/lover/brain/life-api";
import { hearingLabeledCount } from "@/lib/lover/hearing/store";

type ReachRow = {
  enabled: boolean;
  retry: number;
};

type Life = {
  reach: ReachRow;
  log: Array<Record<string, unknown>>;
  counts: { llm: number; sent: number };
};

function clock(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function SettingsLink({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-14 w-full items-center justify-between gap-3 rounded-md bg-surface-2 px-3 text-left"
    >
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint ? <span className="block text-xs text-subtle">{hint}</span> : null}
      </span>
      <span className="text-subtle">›</span>
    </button>
  );
}

export function IdentityField({
  value,
  onChange,
  onCommit,
  paused,
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  paused?: boolean;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm">身份</span>
      <span className="text-xs text-subtle">和人设分开。空着就不放进回复。</span>
      <Textarea
        value={value}
        maxLength={2000}
        className="min-h-28"
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (paused) return;
          onCommit();
        }}
      />
    </label>
  );
}

export function ReachPanel() {
  const [life, setLife] = useState<Life | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function load() {
    void brainGetLife()
      .then((res) => setLife(res as Life))
      .catch(() => setError("主动消息没读出来。"));
  }

  useEffect(() => {
    load();
  }, []);

  if (!life) return <p className="text-sm text-subtle">{error || "正在读…"}</p>;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-subtle">你没说话 45 分钟、3 小时、8 小时、20 小时（之后每天一次）时，他会想一下要不要来找你，想就写一条，不想就不发。这里只是开关和记录。</p>
      {error ? <p className="text-sm text-live">{error}</p> : null}
      {note ? <p className="text-sm text-subtle">{note}</p> : null}
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          checked={life.reach.enabled}
          onChange={(e) => {
            const enabled = e.target.checked;
            setLife({ ...life, reach: { ...life.reach, enabled } });
            void brainSetReach({ data: { enabled } }).catch(() => setError("开关没记下。"));
          }}
        />
        <span className="text-sm">允许他主动找你</span>
      </label>
      <p className="text-xs text-subtle">
        今天：调用 {life.counts.llm} 次 · 发出 {life.counts.sent} 条
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setNote(null);
            void brainTestPush()
              .then((res) => setNote(`测试通知：${JSON.stringify(res.push)}`))
              .catch(() => setError("测试通知没发出去。"));
          }}
        >
          发一条测试通知
        </Button>
        <Button
          type="button"
          onClick={() => {
            setNote("在想…");
            void brainWakeNow()
              .then((res) => {
                setNote(`想起你：${JSON.stringify(res)}`);
                load();
              })
              .catch(() => setError("这次没想起你。"));
          }}
        >
          现在让他想起你
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {life.log.length === 0 ? <p className="text-sm text-subtle">还没有记录。</p> : null}
        {life.log.map((row) => (
          <div key={String(row.id)} className="rounded-md bg-surface-2 px-3 py-2 text-xs">
            <p>
              {clock(Number(row.at) || 0)} · {String(row.trigger ?? "")} · {row.sent ? "发了" : "没发"}
            </p>
            {row.text ? <p className="mt-1 whitespace-pre-wrap">{String(row.text)}</p> : null}
            {row.push_result ? <p className="text-subtle">推送 {String(row.push_result)}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatusPanel({
  voiceModel,
  injectLine,
  phase,
}: {
  voiceModel: string;
  injectLine: string;
  phase: string;
}) {
  const [labeledCount, setLabeledCount] = useState(0);
  useEffect(() => {
    void hearingLabeledCount({ data: {} }).then((result) => {
      if (result.ok) setLabeledCount(result.count);
    });
  }, []);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-xs text-subtle">平时不用看。</p>
      <p>
        已标 {labeledCount} / 200
      </p>
      <p>{injectLine}</p>
      <p className="text-xs text-subtle">回复模型 {voiceModel}</p>
      <p className="text-xs text-subtle">{phase}</p>
    </div>
  );
}

export function ManualEdits() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => {
    void brainListManualEdits()
      .then((list) => setRows(list as Array<Record<string, unknown>>))
      .catch(() => setRows([]));
  }, []);
  if (!rows.length) return <p className="text-sm text-subtle">还没有手改记录。</p>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <details key={String(row.id)} className="rounded-md bg-surface-2 px-3 py-2 text-xs">
          <summary>
            {clock(Number(row.at) || 0)} · {String(row.target ?? "")}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-all text-subtle">{JSON.stringify({ before: row.before, after: row.after }, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}

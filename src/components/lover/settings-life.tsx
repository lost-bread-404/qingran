import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  brainAdjustGlow,
  brainGetLife,
  brainListManualEdits,
  brainSaveHeart,
  brainSetReach,
  brainTestPush,
  brainWakeNow,
} from "@/lib/lover/brain/life-api";
import { glowWord } from "@/lib/lover/brain/life";
import type { InnerPlan, InnerState, LongingItem } from "@/lib/lover/brain/types";
import { hearingLabeledCount } from "@/lib/lover/hearing/store";
import { clampGlowHalfLifeDays } from "@/lib/lover/brain/config";
import { cn } from "@/lib/utils";

type ReachRow = {
  nextAt: number | null;
  intent: string;
  setBy: string;
  setAt: number;
  enabled: boolean;
  retry: number;
};

type GlowRow = { id: number; at: number; delta: number; why: string; source: string; glowAfter: number };

type Life = {
  reach: ReachRow;
  log: Array<Record<string, unknown>>;
  glow: GlowRow[];
  inner: InnerState;
  counts: { llm: number; sent: number };
};

function clock(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function localInput(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

export function HeartEditor({
  halfLifeDays,
  onHalfLife,
}: {
  halfLifeDays: number;
  onHalfLife: (days: number) => void;
}) {
  const [inner, setInner] = useState<InnerState | null>(null);
  const [glow, setGlow] = useState<GlowRow[]>([]);
  const [reach, setReach] = useState<ReachRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [delta, setDelta] = useState("");
  const [why, setWhy] = useState("");

  function load() {
    void brainGetLife()
      .then((res) => {
        const life = res as Life;
        setInner(life.inner);
        setGlow(life.glow);
        setReach(life.reach);
      })
      .catch(() => setError("心没读出来。"));
  }

  useEffect(() => {
    load();
  }, []);

  function save(patch: Partial<{ desire: string; readHer: string; feel: string; now: string; choice: string; plans: InnerPlan[]; longings: LongingItem[] }>) {
    if (!inner) return;
    const next = { ...inner, ...patch, now: patch.now ?? inner.now };
    setInner(next);
    void brainSaveHeart({
      data: {
        desire: next.desire,
        readHer: next.readHer,
        feel: next.feel,
        now: next.now,
        choice: next.choice,
        plans: next.plans,
        longings: next.longings,
      },
    }).catch(() => setError("没记下。"));
  }

  if (!inner) return <p className="text-sm text-subtle">{error || "正在读…"}</p>;
  const word = glowWord(inner.glow);
  const maxGlow = Math.max(60, ...glow.map((row) => Math.abs(row.glowAfter)));

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-live">{error}</p> : null}
      <section className="flex flex-col gap-2">
        <p className="text-sm">此刻</p>
        <p className="text-xs text-subtle">
          他没说出口的。下一轮回复看得到欲望、心里和正在做，取舍和对她的理解他留着自己看。
        </p>
        <p className="text-sm">场景：{inner.scene === "intimate" ? "亲密" : "日常"}</p>
        <p className="text-xs text-subtle">失焦就记下。</p>
        {(
          [
            ["欲望", "desire"],
            ["对她", "readHer"],
            ["心里", "feel"],
            ["取舍", "choice"],
            ["正在做", "now"],
          ] as const
        ).map(([label, key]) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-sm">{label}</span>
            <Textarea
              value={inner[key]}
              className="min-h-16"
              onChange={(e) => setInner({ ...inner, [key]: e.target.value })}
              onBlur={() => save({ [key]: inner[key] })}
            />
          </label>
        ))}
      </section>
      <section className="flex flex-col gap-2">
        <p className="text-sm">计划</p>
        <p className="text-xs text-subtle">
          他接下来想做成的事。达成了标做成了，想法变了就改或标放下了。不会自己过期。
        </p>
        {inner.plans.map((plan, index) => (
          <div key={plan.id || index} className="rounded-md bg-surface-2 p-2">
            <Textarea
              value={plan.what}
              className="min-h-14"
              onChange={(e) => {
                const plans = inner.plans.map((item, i) => (i === index ? { ...item, what: e.target.value } : item));
                setInner({ ...inner, plans });
              }}
              onBlur={() => save({ plans: inner.plans })}
            />
            <div className="mt-2 flex gap-2">
              <select
                className="h-11 flex-1 rounded-md bg-bg px-2 text-sm"
                value={plan.status}
                onChange={(e) => {
                  const plans = inner.plans.map((item, i) =>
                    i === index ? { ...item, status: e.target.value as InnerPlan["status"] } : item,
                  );
                  setInner({ ...inner, plans });
                  save({ plans });
                }}
              >
                <option value="open">进行中</option>
                <option value="done">做成了</option>
                <option value="dropped">放下了</option>
              </select>
              <button
                type="button"
                className="text-sm text-muted"
                onClick={() => save({ plans: inner.plans.filter((_, i) => i !== index) })}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            save({
              plans: [...inner.plans, { id: `rosie-${Date.now()}`, what: "", why: "", status: "open" }],
            })
          }
        >
          加一条计划
        </Button>
      </section>
      <section className="flex flex-col gap-2">
        <p className="text-sm">心事</p>
        <p className="text-xs text-subtle">一直惦记的，几天不说话也还在。</p>
        {inner.longings.map((item, index) => (
          <div key={item.id || index} className="rounded-md bg-surface-2 p-2">
            <Textarea
              value={item.text}
              className="min-h-14"
              onChange={(e) => {
                const longings = inner.longings.map((row, i) => (i === index ? { ...row, text: e.target.value } : row));
                setInner({ ...inner, longings });
              }}
              onBlur={() => save({ longings: inner.longings })}
            />
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xs text-subtle">{item.since || "今天"}</span>
              <button
                type="button"
                className="text-sm text-muted"
                onClick={() => save({ longings: inner.longings.filter((_, i) => i !== index) })}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            save({
              longings: [...inner.longings, { id: `rosie-${Date.now()}`, text: "", since: todayStamp() }],
            })
          }
        >
          加一条心事
        </Button>
      </section>
      <section className="flex flex-col gap-2">
        <p className="text-sm">下一次找你</p>
        <p className="text-xs text-subtle">他打算什么时候再找你、想做什么。可以改，可以清空。</p>
        {reach ? (
          <>
            <Input
              type="datetime-local"
              value={localInput(reach.nextAt)}
              onChange={(e) => {
                const at = e.target.value ? new Date(e.target.value).getTime() : null;
                setReach({ ...reach, nextAt: at });
              }}
              onBlur={() => {
                void brainSetReach({ data: { nextAt: reach.nextAt, intent: reach.intent } }).catch(() => setError("时间没记下。"));
              }}
            />
            <Textarea
              value={reach.intent}
              className="min-h-14"
              placeholder="想做什么"
              onChange={(e) => setReach({ ...reach, intent: e.target.value })}
              onBlur={() => {
                void brainSetReach({ data: { nextAt: reach.nextAt, intent: reach.intent } }).catch(() => setError("没记下。"));
              }}
            />
            <button
              type="button"
              className="text-left text-sm text-muted"
              onClick={() => {
                setReach({ ...reach, nextAt: null, intent: "" });
                void brainSetReach({ data: { clear: true } }).catch(() => setError("没清掉。"));
              }}
            >
              清空
            </button>
          </>
        ) : null}
      </section>
      <section className="flex flex-col gap-2">
        <p className="text-sm">心情</p>
        <p className="text-xs text-subtle">
          {word ? `${word}（比平常）` : "平常"} · {inner.glow.toFixed(1)}
        </p>
        {glow.length === 0 ? (
          <p className="text-sm text-subtle">还没有起伏</p>
        ) : (
          <div className="flex h-16 items-end gap-1">
            {[...glow].reverse().map((row) => (
              <div
                key={row.id}
                title={`${clock(row.at)} ${row.why}`}
                className={cn("w-2 rounded-sm", row.glowAfter >= 0 ? "bg-accent" : "bg-live")}
                style={{ height: `${Math.max(8, (Math.abs(row.glowAfter) / maxGlow) * 100)}%` }}
              />
            ))}
          </div>
        )}
        <label className="flex flex-col gap-1 text-xs text-subtle">
          给他的心情 +/−
          <Input
            aria-label="给他的心情 +/−"
            value={delta}
            placeholder="例如 +10"
            onChange={(e) => setDelta(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-subtle">
          原因
          <Input aria-label="原因" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="原因" />
        </label>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void brainAdjustGlow({ data: { delta: Number(delta) || 0, why } })
              .then(() => {
                setDelta("");
                setWhy("");
                load();
              })
              .catch(() => setError("心情没记下。"));
          }}
        >
          记下
        </Button>
        <label className="text-xs text-subtle">
          开心或难过多久回到平常：{halfLifeDays} 天
          <input
            type="range"
            min={0.5}
            max={7}
            step={0.5}
            value={halfLifeDays}
            aria-label="开心或难过多久回到平常"
            className="mt-1 h-11 w-full accent-accent"
            onChange={(e) => onHalfLife(clampGlowHalfLifeDays(Number(e.target.value)))}
          />
        </label>
      </section>
    </div>
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
      <p className="text-xs text-subtle">发不发、什么时候发，由他决定。这里只是开关和记录。</p>
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
      <p className="text-sm">
        下一次：{life.reach.nextAt ? clock(life.reach.nextAt) : "没有计划"}
        {life.reach.intent ? ` · ${life.reach.intent}` : ""}
        {life.reach.setBy ? ` · ${life.reach.setBy}` : ""}
      </p>
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

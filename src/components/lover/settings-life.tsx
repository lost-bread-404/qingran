import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  brainAdjustGlow,
  brainGenerateBusy,
  brainGetLife,
  brainListManualEdits,
  brainSaveBusy,
  brainSaveHeart,
  brainSaveIdentity,
  brainSetReach,
  brainTestPush,
  brainWakeNow,
} from "@/lib/lover/brain/life-api";
import { glowWord } from "@/lib/lover/brain/life";
import type { InnerPlan, InnerState, LongingItem } from "@/lib/lover/brain/types";
import { hearingLabeledCount } from "@/lib/lover/hearing/store";
import { clampGlowHalfLifeDays } from "@/lib/lover/brain/config";
import { cn } from "@/lib/utils";

type BusyRow = {
  id: string;
  fromDay: string;
  toDay: string;
  busy: number;
  label: string;
  reason: string;
  createdAt: number;
};

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
  identity: string;
  identityUpdatedAt: number;
  rhythm: string;
  periods: BusyRow[];
  busy: { busy: number; label: string; reason: string; rhythm: string };
  generatedAt: number;
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
  onSave,
}: {
  value: string;
  onSave: (identity: string) => void;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(value), [value]);
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm">身份</span>
      <span className="text-xs text-subtle">和人设分开。空着就不放进回复。</span>
      <Textarea
        value={text}
        maxLength={2000}
        className="min-h-28"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const next = text.trim();
          if (next === value.trim()) return;
          void brainSaveIdentity({ data: { identity: next } })
            .then(() => {
              setError(null);
              onSave(next);
            })
            .catch(() => setError("身份没记下。"));
        }}
      />
      {error ? <span className="text-xs text-live">{error}</span> : null}
    </label>
  );
}

export function BusyPanel({ onRhythm }: { onRhythm?: (rhythm: string) => void }) {
  const [life, setLife] = useState<Life | null>(null);
  const [rows, setRows] = useState<BusyRow[]>([]);
  const [rhythm, setRhythm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function apply(next: Life) {
    setLife(next);
    setRows(next.periods);
    setRhythm(next.rhythm);
  }

  useEffect(() => {
    void brainGetLife()
      .then((res) => apply(res as Life))
      .catch(() => setError("日程没读出来。"));
  }, []);

  const stale = Boolean(life && life.generatedAt && life.identityUpdatedAt > life.generatedAt);
  const today = todayStamp();

  return (
    <section className="flex flex-col gap-3">
      <div>
        <p className="text-sm">忙碌表</p>
        <p className="text-xs text-subtle">只影响他什么时候来找你，不改变聊天里怎么说话。</p>
      </div>
      {error ? <p className="text-sm text-live">{error}</p> : null}
      {stale ? <p className="text-sm text-live">身份改过了，要重新生成吗？</p> : null}
      {life?.busy.label ? (
        <p className="text-xs text-subtle">
          现在：{life.busy.label}（{life.busy.busy.toFixed(2)}）{life.busy.reason}
        </p>
      ) : (
        <p className="text-xs text-subtle">还没有对应的时间段。</p>
      )}
      <label className="text-xs text-subtle">
        作息
        <Input
          value={rhythm}
          className="mt-1"
          onChange={(e) => setRhythm(e.target.value)}
          onBlur={() => {
            void brainSaveBusy({ data: { rhythm, periods: rows } })
              .then(() => onRhythm?.(rhythm))
              .catch(() => setError("作息没记下。"));
          }}
        />
      </label>
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const current = row.fromDay <= today && today <= row.toDay;
          return (
            <div key={row.id || index} className={cn("rounded-md bg-surface-2 p-2", current && "ring-1 ring-accent")}>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  aria-label="开始日期"
                  value={row.fromDay}
                  onChange={(e) => setRows((list) => list.map((item, i) => (i === index ? { ...item, fromDay: e.target.value } : item)))}
                  onBlur={() => void brainSaveBusy({ data: { rhythm, periods: rows } }).catch(() => setError("没记下。"))}
                />
                <Input
                  aria-label="结束日期"
                  value={row.toDay}
                  onChange={(e) => setRows((list) => list.map((item, i) => (i === index ? { ...item, toDay: e.target.value } : item)))}
                  onBlur={() => void brainSaveBusy({ data: { rhythm, periods: rows } }).catch(() => setError("没记下。"))}
                />
              </div>
              <Input
                className="mt-2"
                aria-label="名字"
                value={row.label}
                onChange={(e) => setRows((list) => list.map((item, i) => (i === index ? { ...item, label: e.target.value } : item)))}
                onBlur={() => void brainSaveBusy({ data: { rhythm, periods: rows } }).catch(() => setError("没记下。"))}
              />
              <Input
                className="mt-2"
                aria-label="原因"
                value={row.reason}
                onChange={(e) => setRows((list) => list.map((item, i) => (i === index ? { ...item, reason: e.target.value } : item)))}
                onBlur={() => void brainSaveBusy({ data: { rhythm, periods: rows } }).catch(() => setError("没记下。"))}
              />
              <div className="mt-2 flex items-center gap-2">
                <Input
                  aria-label="忙碌程度"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={row.busy}
                  onChange={(e) =>
                    setRows((list) => list.map((item, i) => (i === index ? { ...item, busy: Number(e.target.value) } : item)))
                  }
                  onBlur={() => void brainSaveBusy({ data: { rhythm, periods: rows } }).catch(() => setError("没记下。"))}
                />
                <button
                  type="button"
                  className="h-11 shrink-0 text-sm text-muted"
                  onClick={() => {
                    const next = rows.filter((_, i) => i !== index);
                    setRows(next);
                    void brainSaveBusy({ data: { rhythm, periods: next } }).catch(() => setError("没记下。"));
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            const next = [
              ...rows,
              { id: "", fromDay: today, toDay: today, busy: 0.5, label: "", reason: "", createdAt: 0 },
            ];
            setRows(next);
          }}
        >
          加一段
        </Button>
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void brainGenerateBusy()
              .then(async () => {
                const res = (await brainGetLife()) as Life;
                apply(res);
                onRhythm?.(res.rhythm);
              })
              .catch(() => setError("没生成出来。"))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "在生成…" : "根据身份生成忙碌表"}
        </Button>
      </div>
    </section>
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
  const [delta, setDelta] = useState("0");
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

  function save(patch: Partial<{ feel: string; want: string; now: string; choice: string; plans: InnerPlan[]; longings: LongingItem[] }>) {
    if (!inner) return;
    const next = { ...inner, ...patch, now: patch.now ?? inner.now };
    setInner(next);
    void brainSaveHeart({
      data: {
        feel: next.feel,
        want: next.want,
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
      <p className="text-xs text-subtle">失焦就记下。下一次他想事情时，读到的就是改过的。</p>
      {(
        [
          ["心里", "feel"],
          ["想要", "want"],
          ["正在做", "now"],
          ["取舍", "choice"],
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
      <section className="flex flex-col gap-2">
        <p className="text-sm">计划</p>
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
        <div className="flex gap-2">
          <Input aria-label="心情加减" value={delta} onChange={(e) => setDelta(e.target.value)} />
          <Input aria-label="原因" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="原因" />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void brainAdjustGlow({ data: { delta: Number(delta) || 0, why } })
                .then(() => load())
                .catch(() => setError("心情没记下。"));
            }}
          >
            记下
          </Button>
        </div>
        <label className="text-xs text-subtle">
          半衰期 {halfLifeDays} 天
          <input
            type="range"
            min={0.5}
            max={7}
            step={0.5}
            value={halfLifeDays}
            aria-label="心情半衰期"
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

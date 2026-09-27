import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { brainGetLife, brainListManualEdits, brainSetReach, brainTestPush, brainWakeNow } from "@/lib/lover/brain/life-api";
import {
  brainEditPlan,
  brainGetMind,
  brainSaveToday,
  brainSetModeNow,
} from "@/lib/lover/brain/mind-api";
import { hearingLabeledCount } from "@/lib/lover/hearing/store";
import { cn } from "@/lib/utils";

type ReachRow = {
  nextAt: number | null;
  intent: string;
  setBy: string;
  setAt: number;
  enabled: boolean;
  retry: number;
};

type ReachPlan = { id: number; at: number; intent: string; setBy: string; setAt: number };

type Life = {
  reach: ReachRow;
  plans: ReachPlan[];
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

type Mind = {
  timeZone: string;
  thought: { text: string; updatedAt: number };
  plans: Array<{ id: number; at: number | null; atText: string; due: boolean; current: boolean; text: string; setBy: string }>;
  today: string;
  days: Array<{ day: string; timeline: string }>;
  mode: string;
  modes: Array<{ id: string; name: string }>;
};

const PLAN_BY: Record<string, string> = { rosie: "你加的", reflect: "心思", night: "夜里整理" };

/** 他的心：刚才想的、打算、模式、今天、最近几天。打算和今天你可以改。 */
export function HeartEditor() {
  const [mind, setMind] = useState<Mind | null>(null);
  const [today, setTodayDraft] = useState("");
  const [draftText, setDraftText] = useState("");
  const [draftAt, setDraftAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  function load() {
    void brainGetMind()
      .then((res) => {
        const next = res as Mind;
        setMind(next);
        setTodayDraft(next.today);
      })
      .catch(() => setError("心没读出来。"));
  }

  useEffect(() => {
    load();
  }, []);

  if (!mind) return <p className="text-sm text-subtle">{error || "正在读…"}</p>;

  return (
    <div className="flex flex-col gap-5">
      {error ? <p className="text-sm text-live">{error}</p> : null}
      <section className="flex flex-col gap-2">
        <p className="text-sm">他刚才想的</p>
        <p className="text-xs text-subtle">心思最近一次想到的（只存着给你看，没有模型读它）。想法要么变成下面的打算，要么就不留。</p>
        <p className="whitespace-pre-wrap rounded-md bg-surface-2 px-3 py-2 text-sm">{mind.thought.text || "（空）"}</p>
        <p className="text-xs text-subtle">更新于 {clock(mind.thought.updatedAt)}</p>
      </section>

      <section className="flex flex-col gap-2">
        <p className="text-sm">打算</p>
        <p className="text-xs text-subtle">
          他的打算单，按先后排：你的事，和他自己想要你的事。回复只看得到「现在在做」的那一件（第一件到了时间的，没写时间就是现在），做成了心思就拿掉，下一件接上。写了时间的到点时你不在聊天，他再想一遍，决定要不要给你发一条。
        </p>
        {mind.plans.length === 0 ? <p className="text-sm text-subtle">现在没有打算</p> : null}
        {mind.plans.map((plan) => (
          <div key={plan.id} className="flex items-start justify-between gap-3 rounded-md bg-surface-2 px-3 py-2">
            <p className="text-sm">
              {plan.current ? "现在在做" : plan.at == null ? "接下来" : plan.due ? "到时间了" : plan.atText} · {plan.text}
              <span className="text-xs text-subtle"> · {PLAN_BY[plan.setBy] ?? plan.setBy}</span>
            </p>
            <button
              type="button"
              className="shrink-0 text-sm text-muted"
              onClick={() => {
                setMind({ ...mind, plans: mind.plans.filter((row) => row.id !== plan.id) });
                void brainEditPlan({ data: { remove: plan.id } }).catch(() => setError("没删掉。"));
              }}
            >
              删
            </button>
          </div>
        ))}
        <Textarea value={draftText} className="min-h-14" placeholder="加一件他要做的事" onChange={(e) => setDraftText(e.target.value)} />
        <Input
          value={draftAt}
          placeholder="时间（可空），例如 2026-09-26 23:00"
          onChange={(e) => setDraftAt(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!draftText.trim()}
          onClick={() => {
            void brainEditPlan({ data: { add: { text: draftText.trim(), at: draftAt.trim() } } })
              .then(() => {
                setDraftText("");
                setDraftAt("");
                load();
              })
              .catch(() => setError("没加上。"));
          }}
        >
          加一件
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <p className="text-sm">模式</p>
        <p className="text-xs text-subtle">心思在每轮之后选；这里可以手动换。模式本身在「清然是谁」里改。</p>
        <div className="flex flex-wrap gap-2">
          {mind.modes.map((m) => (
            <button
              key={m.id}
              type="button"
              className={cn("min-h-11 rounded-md px-3 text-sm", m.id === mind.mode ? "bg-accent text-accent-fg" : "bg-surface-2")}
              onClick={() => {
                setMind({ ...mind, mode: m.id });
                void brainSetModeNow({ data: { mode: m.id } }).catch(() => setError("没换成。"));
              }}
            >
              {m.name}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <p className="text-sm">今天</p>
        <p className="text-xs text-subtle">你今天的事、他今天说过编过的关于自己的事、还欠着的事。你沉默时他整段重写，回复看得到。凌晨整理成那天的时间线。记错了可以直接改。</p>
        <Textarea
          value={today}
          className="min-h-28"
          placeholder="还没有"
          onChange={(e) => setTodayDraft(e.target.value)}
          onBlur={() => {
            if (today === mind.today) return;
            void brainSaveToday({ data: { text: today } })
              .then(() => setMind({ ...mind, today }))
              .catch(() => setError("没记下。"));
          }}
        />
      </section>

      <section className="flex flex-col gap-2">
        <p className="text-sm">最近几天</p>
        <p className="text-xs text-subtle">每天凌晨整理时定稿的时间线。</p>
        {mind.days.filter((d) => d.timeline.trim()).length === 0 ? <p className="text-sm text-subtle">还没有</p> : null}
        {mind.days
          .filter((d) => d.timeline.trim())
          .map((d) => (
            <div key={d.day} className="rounded-md bg-surface-2 px-3 py-2 text-sm">
              <p className="text-xs text-subtle">{d.day}</p>
              <p className="whitespace-pre-wrap">{d.timeline}</p>
            </div>
          ))}
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
        打算找你：{life.plans?.length ? life.plans.map((plan) => `${clock(plan.at)} ${plan.intent || "（没写）"}`).join("；") : "没有计划"}
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

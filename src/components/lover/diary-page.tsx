import { ArrowLeft, Check, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  brainAskDiary,
  brainGetDay,
  brainGetExperiments,
  brainGetIntentions,
  brainGetOverview,
  brainGetReports,
  brainGetTheme,
  brainGetThemes,
  brainRunJobs,
  brainSetFeedback,
  brainStartExperiment,
} from "@/lib/lover/brain/api";
import type {
  DayLog,
  Episode,
  Experiment,
  Factor,
  Finding,
  Intention,
  Note,
  StoredMessage,
  Theme,
} from "@/lib/lover/brain/types";
import { cn } from "@/lib/utils";

type Tab = "overview" | "report" | "saydo" | "themes" | "experiments" | "ask";

type Overview = Awaited<ReturnType<typeof brainGetOverview>>;
type ReportRow = Awaited<ReturnType<typeof brainGetReports>>[number];

export function DiaryPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [intentions, setIntentions] = useState<Intention[]>([]);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<{
    log: DayLog | null;
    notes: Note[];
    messages: StoredMessage[];
  } | null>(null);
  const [themeId, setThemeId] = useState<string | null>(null);
  const [themeDetail, setThemeDetail] = useState<Awaited<ReturnType<typeof brainGetTheme>> | null>(
    null,
  );
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("diary-scroll");
    return () => document.documentElement.classList.remove("diary-scroll");
  }, []);

  async function loadAll() {
    try {
      const [ov, reps, ints, th, ex] = await Promise.all([
        brainGetOverview(),
        brainGetReports(),
        brainGetIntentions(),
        brainGetThemes(),
        brainGetExperiments(),
      ]);
      setOverview(ov);
      setReports(reps);
      setIntentions(ints);
      setThemes(th);
      setExperiments(ex);
      setError(null);
    } catch {
      setError("日记这会儿读不出来。");
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (!day) {
      setDayDetail(null);
      return;
    }
    void brainGetDay({ data: { day } }).then(setDayDetail);
  }, [day]);

  useEffect(() => {
    if (!themeId) {
      setThemeDetail(null);
      return;
    }
    void brainGetTheme({ data: { id: themeId } }).then(setThemeDetail);
  }, [themeId]);

  async function run(types: Array<"dusk" | "synth" | "report">, label: string) {
    setBusy(label);
    try {
      await brainRunJobs({ data: { types } });
      await loadAll();
    } finally {
      setBusy(null);
    }
  }

  const chart = useMemo(() => {
    if (!overview) return [];
    return overview.days.map((d) => ({
      day: d.day.slice(5),
      full: d.day,
      energy: d.energy,
      mood: d.mood,
      coverage: d.coverage === "ok" ? 1 : d.coverage === "thin" ? 0.4 : 0,
    }));
  }, [overview]);

  const factorsById = useMemo(() => {
    const map = new Map<string, Factor>();
    for (const f of overview?.factors ?? []) map.set(f.id, f);
    return map;
  }, [overview]);

  const tabs: Array<[Tab, string]> = [
    ["overview", "总览"],
    ["report", "月报"],
    ["saydo", "说做"],
    ["themes", "主题"],
    ["experiments", "实验"],
    ["ask", "问日记"],
  ];

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <div className="mx-auto flex w-full max-w-2xl flex-col px-5 pb-16 pt-[max(1rem,env(safe-area-inset-top))]">
        <header className="mb-6 flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild aria-label="回通话">
            <Link to="/">
              <ArrowLeft className="size-5" />
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl font-medium tracking-tight">日记</h1>
            <p className="text-xs text-subtle">只给你看。清然不参与。</p>
          </div>
        </header>

        {overview?.safety_flag ? (
          <p className="mb-5 rounded-lg bg-live/15 px-4 py-3 text-sm leading-relaxed text-fg">
            最近几周低落的时间明显变多了。这种趋势值得和信任的人或专业人士聊一聊。
          </p>
        ) : null}

        {error ? <p className="mb-4 text-sm text-live">{error}</p> : null}

        <div className="mb-5 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void run(["dusk"], "整理今天")}
          >
            {busy === "整理今天" ? "在整理…" : "整理今天"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void run(["synth"], "立即周分析")}
          >
            {busy === "立即周分析" ? "在分析…" : "立即周分析"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void run(["report"], "生成本月报告")}
          >
            {busy === "生成本月报告" ? "在写…" : "生成本月报告"}
          </Button>
        </div>

        <div className="mb-6 flex gap-1 overflow-x-auto">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "shrink-0 rounded-md px-3 py-2 text-sm",
                tab === id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "overview" ? (
          <section className="flex flex-col gap-6">
            <div className="h-56 rounded-xl bg-surface p-3">
              {chart.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chart}>
                    <CartesianGrid stroke="color-mix(in oklab, var(--color-fg) 8%, transparent)" />
                    <XAxis dataKey="day" tick={{ fill: "var(--color-subtle)", fontSize: 11 }} />
                    <YAxis domain={[-1, 1]} tick={{ fill: "var(--color-subtle)", fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--color-surface-2)",
                        border: "none",
                        color: "var(--color-fg)",
                      }}
                    />
                    <Area type="monotone" dataKey="mood" stroke="var(--color-accent)" fill="var(--color-accent)" fillOpacity={0.18} />
                    <Area type="monotone" dataKey="energy" stroke="var(--color-muted)" fill="transparent" />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <p className="grid h-full place-items-center text-sm text-subtle">还没有可画的日子。</p>
              )}
            </div>
            <EpisodeList episodes={overview?.episodes ?? []} factors={factorsById} />
            <div>
              <h2 className="mb-3 font-display text-lg">日子</h2>
              <ul className="flex flex-col gap-2">
                {(overview?.days ?? [])
                  .slice()
                  .reverse()
                  .map((d) => (
                    <li key={d.day}>
                      <button
                        type="button"
                        onClick={() => setDay(d.day === day ? null : d.day)}
                        className="flex w-full items-center justify-between rounded-md bg-surface-2 px-3 py-2 text-left text-sm"
                      >
                        <span>{d.day}</span>
                        <span className="text-xs text-subtle">
                          {d.coverage === "ok" ? "够看" : d.coverage === "thin" ? "偏薄" : "没有"}
                          {d.mood != null ? ` · 情绪 ${d.mood}` : ""}
                        </span>
                      </button>
                      {day === d.day && dayDetail ? <DayDetail detail={dayDetail} /> : null}
                    </li>
                  ))}
              </ul>
            </div>
          </section>
        ) : null}

        {tab === "report" ? (
          <section className="flex flex-col gap-6">
            {reports.length === 0 ? (
              <p className="text-sm text-subtle">还没有月报。月初会写上一月的，也可以手动生成。</p>
            ) : (
              reports.map((r) => (
                <article key={r.id} className="rounded-xl bg-surface p-4">
                  <h2 className="font-display text-lg">{r.id}</h2>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{r.narrative || "数字已经算好，解读还没写成。"}</p>
                  <FindingsBlock
                    findings={(overview?.findings ?? []).filter((f) => f.kind === "antecedent").slice(0, 5)}
                    factors={factorsById}
                    onFeedback={(id, feedback) =>
                      void brainSetFeedback({ data: { kind: "finding", id, feedback } }).then(loadAll)
                    }
                  />
                </article>
              ))
            )}
          </section>
        ) : null}

        {tab === "saydo" ? (
          <section className="flex flex-col gap-3">
            {intentions.length === 0 ? (
              <p className="text-sm text-subtle">还没有她说过要做的事。</p>
            ) : (
              intentions.map((it) => (
                <div key={it.id} className="rounded-md bg-surface-2 px-3 py-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-subtle">{it.tag || "未分类"}</span>
                    <span className="text-xs text-subtle">{statusLabel(it.status)}</span>
                  </div>
                  <p className="mt-1 leading-relaxed">{it.text}</p>
                </div>
              ))
            )}
          </section>
        ) : null}

        {tab === "themes" ? (
          <section className="flex flex-col gap-3">
            {themes.length === 0 ? (
              <p className="text-sm text-subtle">周分析之后会出现主题。</p>
            ) : (
              themes.map((t) => (
                <div key={t.id} className="rounded-md bg-surface-2 px-3 py-3">
                  <button type="button" className="w-full text-left" onClick={() => setThemeId(themeId === t.id ? null : t.id)}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm">{t.name}</span>
                      <span className="text-xs text-subtle">{t.status}</span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-subtle">{t.definition}</p>
                  </button>
                  <FeedbackRow
                    value={t.userFeedback}
                    onChange={(feedback) =>
                      void brainSetFeedback({ data: { kind: "theme", id: t.id, feedback } }).then(loadAll)
                    }
                  />
                  {themeId === t.id && themeDetail ? (
                    <ul className="mt-3 flex flex-col gap-2">
                      {(themeDetail.notes ?? []).map((n) => (
                        <li key={n.id} className="text-xs leading-relaxed text-muted">
                          {n.localDay} · {n.text}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))
            )}
          </section>
        ) : null}

        {tab === "experiments" ? (
          <section className="flex flex-col gap-3">
            {experiments.length === 0 ? (
              <p className="text-sm text-subtle">月报里会提出可以试的一件事。</p>
            ) : (
              experiments.map((ex) => (
                <div key={ex.id} className="rounded-md bg-surface-2 px-3 py-3 text-sm">
                  <p className="leading-relaxed">{ex.hypothesis}</p>
                  <p className="mt-1 text-xs text-subtle">要做：{ex.action}</p>
                  <p className="mt-1 text-xs text-subtle">
                    {ex.startDay} → {ex.endDay} · {ex.status}
                  </p>
                  {ex.status === "proposed" ? (
                    <Button
                      className="mt-3"
                      size="sm"
                      onClick={() => void brainStartExperiment({ data: { id: ex.id } }).then(loadAll)}
                    >
                      开始这件
                    </Button>
                  ) : null}
                  {ex.result ? (
                    <pre className="mt-2 overflow-x-auto text-xs text-subtle">
                      {JSON.stringify(ex.result, null, 2)}
                    </pre>
                  ) : null}
                </div>
              ))
            )}
          </section>
        ) : null}

        {tab === "ask" ? (
          <section className="flex flex-col gap-3">
            <Textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="问这本日记一件具体的事"
              className="min-h-28"
            />
            <Button
              disabled={!question.trim() || Boolean(busy)}
              onClick={() => {
                const q = question.trim();
                if (!q) return;
                setBusy("问");
                void brainAskDiary({ data: { question: q } })
                  .then((res) => setAnswer(res.text || "数据不足，我还没法回答这个。"))
                  .finally(() => setBusy(null));
              }}
            >
              {busy === "问" ? "在翻…" : "问"}
            </Button>
            {answer ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{answer}</p> : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function statusLabel(status: Intention["status"]) {
  if (status === "done") return "做成了";
  if (status === "started") return "开始了";
  if (status === "dropped") return "放下了";
  return "还开着";
}

function EpisodeList({
  episodes,
  factors,
}: {
  episodes: Episode[];
  factors: Map<string, Factor>;
}) {
  if (!episodes.length) return null;
  return (
    <div>
      <h2 className="mb-3 font-display text-lg">状态片段</h2>
      <ul className="flex flex-col gap-2">
        {episodes.slice(-24).map((e) => (
          <li key={e.id} className="rounded-md bg-surface-2 px-3 py-2 text-sm">
            {factors.get(e.factorId)?.name ?? e.factorId}
            <span className="ml-2 text-xs text-subtle">
              {e.startDay}
              {e.endDay ? ` → ${e.endDay}` : ""}
              {e.endKnown ? "" : " · 还没结束"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FindingsBlock({
  findings,
  factors,
  onFeedback,
}: {
  findings: Finding[];
  factors: Map<string, Factor>;
  onFeedback: (id: string, feedback: string | null) => void;
}) {
  if (!findings.length) return null;
  return (
    <ul className="mt-4 flex flex-col gap-2">
      {findings.map((f) => (
        <li key={f.id} className="rounded-md bg-surface-2 px-3 py-2 text-xs leading-relaxed">
          {factors.get(f.antecedentId)?.name ?? f.antecedentId}
          经常出现在
          {factors.get(f.outcomeId)?.name ?? f.outcomeId}
          之前（{f.n11} 次，lift {f.lift.toFixed(1)}）
          <FeedbackRow value={f.userFeedback} onChange={(v) => onFeedback(f.id, v)} />
        </li>
      ))}
    </ul>
  );
}

function FeedbackRow({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <div className="mt-2 flex gap-2">
      <button
        type="button"
        aria-label="认同"
        onClick={() => onChange(value === "confirmed" ? null : "confirmed")}
        className={cn("grid size-8 place-items-center rounded-md", value === "confirmed" ? "bg-accent text-accent-fg" : "text-subtle")}
      >
        <Check className="size-4" />
      </button>
      <button
        type="button"
        aria-label="不像"
        onClick={() => onChange(value === "rejected" ? null : "rejected")}
        className={cn("grid size-8 place-items-center rounded-md", value === "rejected" ? "bg-live text-fg" : "text-subtle")}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function DayDetail({
  detail,
}: {
  detail: { log: DayLog | null; notes: Note[]; messages: StoredMessage[] };
}) {
  const log = detail.log;
  return (
    <div className="mt-2 rounded-md bg-surface px-3 py-3 text-sm">
      {log?.summary ? <p className="leading-relaxed">{log.summary}</p> : <p className="text-subtle">这一天还没有整理。</p>}
      {detail.notes.length ? (
        <ul className="mt-3 flex flex-col gap-1 text-xs text-muted">
          {detail.notes.map((n) => (
            <li key={n.id}>{n.text}</li>
          ))}
        </ul>
      ) : null}
      {detail.messages.length ? (
        <ul className="mt-3 flex flex-col gap-1 text-xs text-subtle">
          {detail.messages.slice(0, 12).map((m) => (
            <li key={m.id}>
              {m.role === "user" ? "Rosie" : "清然"}：{m.text.slice(0, 80)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

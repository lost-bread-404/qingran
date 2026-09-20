import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmTurn } from "@/components/lover/confirm-turn";
import {
  confirmHearingClip,
  deleteHearingClip,
  exportEvalCompare,
  exportHearingClips,
  exportReplyFlags,
  getHearingClipAudio,
  hearingEvalCompare,
  hearingLabScore,
  listLabeledHearingClips,
  listReplyFlags,
  runEngineEvalBatch,
  unlabelHearingClip,
  unlockHearingLab,
  type EngineEvalScore,
  type LabeledClipRow,
  type ReplyFlagRow,
} from "@/lib/lover/hearing/store";
import { HEARING_PROVIDERS, type HearingProviderId } from "@/lib/lover/hearing/config";
import { EMOTIONS, type CueEmotion } from "@/lib/lover/hearing/schema";
import type { HearingScore, ScoreWindow, WorstClip } from "@/lib/lover/hearing/score";
import { formatEngineMix } from "@/lib/lover/hearing/select";
import { TAG_EVENT_VALUES, TAG_LABELS, TAG_VALUE_LABELS, type AcousticTags, type EventPr } from "@/lib/lover/hearing/tags";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/lab")({ component: HearingLabPage });

const LAB_KEY = "qingran-hearing-lab";

const ENGINE_LABEL: Record<HearingProviderId, string> = {
  xai: "xAI",
  qwen: "Qwen",
  gemini: "Gemini",
  selfhost: "自建",
};

const FAIL_LABEL = {
  hard_refusal: "硬拒答",
  soft_refusal: "软拒答",
  timeout: "超时",
  error: "报错",
} as const;

const EMOTION_LABEL: Record<CueEmotion, string> = {
  coy: "撒娇",
  playful: "玩",
  content: "满足",
  sleepy: "困",
  sad: "委屈",
  annoyed: "烦",
  neutral: "平",
};

type ScorePayload = HearingScore & {
  ok: boolean;
  error?: string;
  dbSource?: string;
  window: ScoreWindow;
};

type LabEdit = {
  id: string;
  turnId: string | null;
  hyp: string;
  gold: string;
  noiseOnly: boolean;
  literalMismatch: boolean;
  toneNote: string | null;
  predictedTags: AcousticTags | null;
  goldTags: Partial<AcousticTags> | null;
};

function fromWorst(row: WorstClip): LabEdit {
  return {
    id: row.id,
    turnId: row.turnId,
    hyp: row.hyp,
    gold: row.gold,
    noiseOnly: row.noiseOnly,
    literalMismatch: row.literalMismatch,
    toneNote: row.toneNote,
    predictedTags: row.predictedTags ?? null,
    goldTags: row.goldTags ?? null,
  };
}

function fromLabeled(row: LabeledClipRow): LabEdit {
  return {
    id: row.id,
    turnId: row.turnId,
    hyp: row.finalText,
    gold: row.goldText,
    noiseOnly: row.noiseOnly,
    literalMismatch: row.literalMismatch,
    toneNote: row.toneNote,
    predictedTags: row.predictedTags,
    goldTags: row.goldTags,
  };
}

function HearingLabPage() {
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowId, setWindowId] = useState<ScoreWindow>("7d");
  const [score, setScore] = useState<ScorePayload | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [editClip, setEditClip] = useState<LabEdit | null>(null);
  const [editAudio, setEditAudio] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [labeled, setLabeled] = useState<LabeledClipRow[]>([]);
  const [labeledTotal, setLabeledTotal] = useState(0);
  const [labeledPage, setLabeledPage] = useState(1);
  const labeledPageSize = 30;
  const [flags, setFlags] = useState<ReplyFlagRow[]>([]);
  const [evalEngines, setEvalEngines] = useState<Record<HearingProviderId, boolean>>({
    xai: true,
    qwen: true,
    gemini: true,
    selfhost: true,
  });
  const [evalLimit, setEvalLimit] = useState("");
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalProgress, setEvalProgress] = useState<{ done: number; total: number } | null>(null);
  const [evalScores, setEvalScores] = useState<EngineEvalScore[] | null>(null);

  async function loadFlags(secret = password) {
    try {
      const next = await listReplyFlags({ data: { password: secret } });
      if (!next.ok) {
        setStatus(next.error);
        return;
      }
      setFlags(next.flags);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadLabeled(secret = password, page = labeledPage) {
    try {
      const next = await listLabeledHearingClips({ data: { password: secret, page } });
      if (!next.ok) {
        setStatus(next.error);
        return;
      }
      setLabeled(next.clips);
      setLabeledTotal(next.total);
      setLabeledPage(next.page);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function load(secret = password, nextWindow = windowId, page = labeledPage) {
    try {
      const next = await hearingLabScore({ data: { password: secret, window: nextWindow } });
      if (!next.ok) {
        setError(next.error);
        setScore(next);
        return;
      }
      setError(null);
      setScore(next);
      await loadLabeled(secret, page);
      await loadFlags(secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function playClip(id: string) {
    if (playUrl) URL.revokeObjectURL(playUrl);
    const result = await getHearingClipAudio({ data: { password, id } });
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
    setPlayUrl(url);
    const audio = new Audio(url);
    void audio.play();
  }

  async function unlock() {
    setError(null);
    try {
      const result = await unlockHearingLab({ data: { password } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      sessionStorage.setItem(LAB_KEY, password);
      setUnlocked(true);
      await load(password, windowId, 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    const saved = sessionStorage.getItem(LAB_KEY);
    if (!saved) return;
    setPassword(saved);
    void unlockHearingLab({ data: { password: saved } }).then((result) => {
      if (!result.ok) return;
      setUnlocked(true);
      void load(saved, windowId, 1);
    });
  }, []);

  useEffect(() => {
    if (!editClip) {
      setEditAudio((url) => {
        if (url) URL.revokeObjectURL(url);
        return null;
      });
      return;
    }
    let revoked = false;
    let url: string | null = null;
    void getHearingClipAudio({ data: { password, id: editClip.id } }).then((result) => {
      if (!result.ok || revoked) return;
      const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      setEditAudio(url);
    });
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [editClip?.id, password]);

  const labeledPages = Math.max(1, Math.ceil(labeledTotal / labeledPageSize));

  if (!unlocked) {
    return (
      <div className="flex h-full flex-col bg-bg">
        <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <Link to="/" className="text-sm text-muted">
            返回
          </Link>
        </header>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6">
          <p className="font-display text-2xl">听力标注</p>
          <p className="max-w-sm text-center text-sm text-muted">设置里的标注页，需要密码。</p>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            className="max-w-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") void unlock();
            }}
          />
          {error ? <p className="text-sm text-live">{error}</p> : null}
          <Button onClick={() => void unlock()}>打开</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link to="/" className="text-sm text-muted">
          返回
        </Link>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg">成绩</p>
          <p className="text-xs text-subtle">
            {score ? `${score.clipN} 段 · 有 gold ${score.goldN}` : "读取数据库…"}
            {score?.dbSource ? ` · ${score.dbSource}` : ""}
          </p>
        </div>
      </header>

      {error ? <p className="mx-4 mb-2 text-sm text-live">{error}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
          <section className="rounded-md bg-surface-2 px-3 py-3">
            <div className="mb-3 flex gap-2">
              {(
                [
                  ["7d", "最近 7 天"],
                  ["all", "全部"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setWindowId(id);
                    void load(password, id);
                  }}
                  className={cn(
                    "min-h-11 flex-1 rounded-md text-sm",
                    windowId === id ? "bg-accent text-accent-fg" : "bg-bg text-muted",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <ScoreCard score={score} />
          </section>

          <EngineCompare
            engines={evalEngines}
            limit={evalLimit}
            running={evalRunning}
            progress={evalProgress}
            scores={evalScores}
            onToggle={(id) => setEvalEngines((cur) => ({ ...cur, [id]: !cur[id] }))}
            onLimit={setEvalLimit}
            onRun={async () => {
              const selected = HEARING_PROVIDERS.filter((id) => evalEngines[id]);
              if (!selected.length) {
                setStatus("请选择引擎。");
                return;
              }
              const limit = evalLimit.trim() ? Number(evalLimit) : undefined;
              if (evalLimit.trim() && (!Number.isFinite(limit) || (limit ?? 0) < 1)) {
                setStatus("最近 N 条要填正整数，或者留空表示全部。");
                return;
              }
              setEvalRunning(true);
              setStatus(null);
              setEvalProgress({ done: 0, total: 0 });
              try {
                let offset = 0;
                let done = false;
                let total = 0;
                while (!done) {
                  const next = await runEngineEvalBatch({
                    data: { password, engines: selected, limit: limit || null, offset },
                  });
                  if (!next.ok) {
                    setStatus(next.error);
                    return;
                  }
                  offset = next.nextOffset;
                  done = next.done;
                  total = next.total;
                  setEvalProgress({ done: Math.min(offset, next.total), total: next.total });
                  const scored = await hearingEvalCompare({
                    data: { password, engines: selected, limit: limit || null },
                  });
                  if (scored.ok) setEvalScores(scored.engines);
                }
                setStatus(total === 0 ? "没有可对比的已标注录音。" : "对比跑完了。");
              } catch (err) {
                setStatus(err instanceof Error ? err.message : String(err));
              } finally {
                setEvalRunning(false);
              }
            }}
            onExport={async () => {
              try {
                const selected = HEARING_PROVIDERS.filter((id) => evalEngines[id]);
                const limit = evalLimit.trim() ? Number(evalLimit) : undefined;
                const exported = await exportEvalCompare({
                  data: { password, engines: selected, limit: limit || null },
                });
                const blob = new Blob([`${JSON.stringify(exported)}\n`], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `qingran-engine-eval-${new Date().toISOString().slice(0, 10)}.json`;
                link.click();
                URL.revokeObjectURL(url);
                setStatus("已导出引擎对比 JSON。");
              } catch (err) {
                setStatus(err instanceof Error ? err.message : String(err));
              }
            }}
          />

          <section>
            <p className="mb-2 font-display text-lg">最差 20 条</p>
            {!score?.worst.length ? (
              <p className="text-sm text-subtle">还没有带 gold 的 clip。</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {score.worst.map((row) => (
                  <li key={row.id} className="rounded-md bg-surface-2 px-3 py-3">
                    <p className="text-xs text-subtle">
                      CER {(row.cer * 100).toFixed(0)}%
                      {row.emotion && isEmotion(row.emotion) ? ` · ${EMOTION_LABEL[row.emotion]}` : ""}
                      {row.literalMismatch ? " · 字面≠意思" : ""}
                      {row.toneNote ? ` · ${row.toneNote}` : ""}
                      {row.noiseOnly ? " · 噪音" : ""}
                    </p>
                    <p className="mt-1 text-sm">识别 {row.hyp || "（空）"}</p>
                    <p className="text-sm text-muted">正确 {row.gold || "（空）"}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => void playClip(row.id)}>
                        播放
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditError(null);
                          setEditClip(fromWorst(row));
                        }}
                      >
                        重新编辑
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          if (!window.confirm("删掉这段录音？")) return;
                          try {
                            await deleteHearingClip({ data: { password, id: row.id } });
                            setStatus("已删除。");
                            await load();
                          } catch (err) {
                            setStatus(err instanceof Error ? err.message : String(err));
                          }
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <p className="mb-2 font-display text-lg">最近标注</p>
            <p className="mb-3 text-xs text-subtle">
              {labeledTotal ? `共 ${labeledTotal} 条 · 每页 ${labeledPageSize}` : "还没有标注。"}
            </p>
            {labeled.length ? (
              <ul className="flex flex-col gap-3">
                {labeled.map((row) => (
                  <li key={row.id} className="rounded-md bg-surface-2 px-3 py-3">
                    <p className="text-xs text-subtle">
                      {row.goldSource === "edited" ? "✎ edited" : "✓ confirmed"}
                      {row.noiseOnly ? " · 噪音" : ""}
                      {row.literalMismatch ? " · 字面≠意思" : ""}
                      {row.toneNote ? ` · ${row.toneNote}` : ""}
                      {row.hearToTriggerMs != null ? ` · 接话 ${row.hearToTriggerMs}ms` : ""}
                      {row.prerollPeakRms != null ? ` · 前1.5秒峰值 ${row.prerollPeakRms.toFixed(3)}` : ""}
                    </p>
                    <p className="mt-1 text-sm">识别 {row.finalText || "（空）"}</p>
                    <p className="text-sm text-muted">标注 {row.goldText || "（空）"}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => void playClip(row.id)}>
                        播放
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditError(null);
                          setEditClip(fromLabeled(row));
                        }}
                      >
                        重新编辑
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          try {
                            const result = await unlabelHearingClip({ data: { password, id: row.id } });
                            if (!result.ok) {
                              setStatus(result.error);
                              return;
                            }
                            setStatus("已撤销标注。");
                            await load();
                          } catch (err) {
                            setStatus(err instanceof Error ? err.message : String(err));
                          }
                        }}
                      >
                        撤销标注
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {labeledTotal > labeledPageSize ? (
              <div className="mt-3 flex items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={labeledPage <= 1}
                  onClick={() => void load(password, windowId, labeledPage - 1)}
                >
                  上一页
                </Button>
                <p className="text-xs text-subtle">
                  {labeledPage} / {labeledPages}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={labeledPage >= labeledPages}
                  onClick={() => void load(password, windowId, labeledPage + 1)}
                >
                  下一页
                </Button>
              </div>
            ) : null}
          </section>

          <section>
            <p className="mb-2 font-display text-lg">👎 列表</p>
            <p className="mb-3 text-xs text-subtle">
              {flags.length ? `${flags.length} 条不好的回复，用作 prompt eval。` : "还没有标记不好的回复。"}
            </p>
            {flags.length ? (
              <ul className="flex flex-col gap-3">
                {flags.map((row) => (
                  <li key={row.id} className="rounded-md bg-surface-2 px-3 py-3">
                    <p className="text-xs text-subtle">{row.createdAt}</p>
                    <p className="mt-1 text-sm">你 {row.triggerText || "（空）"}</p>
                    <p className="text-sm text-muted">清然 {row.replyText || "（空）"}</p>
                    {row.note ? <p className="mt-1 text-sm">备注 {row.note}</p> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    const exported = await exportReplyFlags({ data: { password } });
                    const blob = new Blob([`${JSON.stringify(exported)}\n`], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `qingran-prompt-eval-${new Date().toISOString().slice(0, 10)}.json`;
                    link.click();
                    URL.revokeObjectURL(url);
                    setStatus("已导出 👎 JSON。");
                  } catch (err) {
                    setStatus(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                导出 👎 JSON
              </Button>
            </div>
          </section>

          <section>
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                try {
                  const exported = await exportHearingClips({ data: { password } });
                  const blob = new Blob([`${JSON.stringify(exported)}\n`], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `qingran-hearing-${new Date().toISOString().slice(0, 10)}.json`;
                  link.click();
                  URL.revokeObjectURL(url);
                  setStatus("已导出 JSON（dev/test 按 id hash 80/20）。");
                } catch (err) {
                  setStatus(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              导出 JSON
            </Button>
            {status ? <p className="mt-2 text-sm text-subtle">{status}</p> : null}
          </section>
        </div>
      </div>

      <ConfirmTurn
        open={Boolean(editClip)}
        sttText={editClip?.hyp || ""}
        initialDraft={editClip?.gold || editClip?.hyp || ""}
        audioUrl={editAudio}
        busy={editBusy}
        error={editError}
        initialNoise={Boolean(editClip?.noiseOnly)}
        initialLiteralMismatch={Boolean(editClip?.literalMismatch)}
        initialToneNote={editClip?.toneNote ?? ""}
        initialPredicted={editClip?.predictedTags}
        initialGoldTags={editClip?.goldTags}
        onClose={() => {
          setEditClip(null);
          setEditError(null);
        }}
        onConfirm={async ({ goldText, source, noiseOnly, literalMismatch, toneNote, goldTags, tagsTouched }) => {
          if (!editClip?.turnId) {
            setEditError("这条没有 turn_id，没法写入。");
            return;
          }
          setEditBusy(true);
          setEditError(null);
          try {
            const result = await confirmHearingClip({
              data: {
                turnId: editClip.turnId,
                goldText,
                goldSource: source,
                noiseOnly,
                literalMismatch,
                toneNote,
                goldTags,
                tagsTouched,
              },
            });
            if (!result.ok) {
              setEditError(result.error);
              return;
            }
            setEditClip(null);
            setStatus("已保存标注。");
            await load();
          } catch (err) {
            setEditError(err instanceof Error ? err.message : String(err));
          } finally {
            setEditBusy(false);
          }
        }}
      />
    </div>
  );
}

function EngineCompare({
  engines,
  limit,
  running,
  progress,
  scores,
  onToggle,
  onLimit,
  onRun,
  onExport,
}: {
  engines: Record<HearingProviderId, boolean>;
  limit: string;
  running: boolean;
  progress: { done: number; total: number } | null;
  scores: EngineEvalScore[] | null;
  onToggle: (id: HearingProviderId) => void;
  onLimit: (value: string) => void;
  onRun: () => void;
  onExport: () => void;
}) {
  return (
    <section className="rounded-md bg-surface-2 px-3 py-3">
      <p className="mb-2 font-display text-lg">引擎对比</p>
      <p className="mb-3 text-xs text-subtle">只读已标注录音，不改对话。每次 10 条，同一 clip 同一引擎再跑会覆盖。</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {HEARING_PROVIDERS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={engines[id]}
            onClick={() => onToggle(id)}
            className={cn(
              "min-h-11 rounded-md px-3 text-sm",
              engines[id] ? "bg-accent text-accent-fg" : "bg-bg text-muted",
            )}
          >
            {ENGINE_LABEL[id]}
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={limit}
          onChange={(e) => onLimit(e.target.value)}
          inputMode="numeric"
          placeholder="最近 N 条，空=全部"
          aria-label="最近 N 条"
          className="max-w-[11rem]"
        />
        <Button type="button" disabled={running} onClick={onRun}>
          {running ? "正在跑…" : "开始对比"}
        </Button>
        <Button type="button" variant="outline" disabled={running} onClick={onExport}>
          导出对比 JSON
        </Button>
      </div>
      {progress ? (
        <p className="mb-3 text-sm text-subtle">
          {progress.total === 0 ? "没有可对比的录音。" : `已跑 ${progress.done} / ${progress.total}`}
        </p>
      ) : null}
      {scores?.length ? (
        <div className="flex flex-col gap-4">
          {scores.map((row) => (
            <EngineEvalCard key={row.engine} score={row} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function EngineEvalCard({ score }: { score: EngineEvalScore }) {
  const engine = (HEARING_PROVIDERS as readonly string[]).includes(score.engine)
    ? ENGINE_LABEL[score.engine as HearingProviderId]
    : score.engine;
  return (
    <div className="rounded-md bg-bg px-3 py-3">
      <p className="mb-2 font-medium">{engine}</p>
      <dl className="flex flex-col gap-2 text-sm">
        <Row label="CER" value={score.n === 0 ? "无数据" : fmtCer(score.cer)} main />
        <Row label="完全正确率" value={fmtPct(score.exactMatch)} />
        <Row
          label="拒答率"
          value={
            score.n === 0
              ? "无数据"
              : (Object.keys(FAIL_LABEL) as (keyof typeof FAIL_LABEL)[])
                  .map((key) => `${FAIL_LABEL[key]} ${fmtPct(score.refusals[key] / score.n)}`)
                  .join(" · ")
          }
        />
        <Row label={`声学标签 · ${TAG_LABELS.length}`} value={fmtPct(score.tagAccuracy.length)} />
        <Row label={`声学标签 · ${TAG_LABELS.contour}`} value={fmtPct(score.tagAccuracy.contour)} />
        <Row label={`声学标签 · ${TAG_LABELS.voice}`} value={fmtPct(score.tagAccuracy.voice)} />
        {TAG_EVENT_VALUES.map((event) => (
          <Row
            key={event}
            label={`声学标签 · ${TAG_VALUE_LABELS.events[event]}`}
            value={fmtEventPr(score.tagAccuracy.events[event])}
          />
        ))}
        <Row
          label="延迟"
          value={
            score.latencyP50 == null
              ? "无数据"
              : `p50 ${Math.round(score.latencyP50)}ms · p95 ${Math.round(score.latencyP95 ?? score.latencyP50)}ms`
          }
        />
        <Row label="条数" value={`${score.okN} 成功 / ${score.n}`} />
      </dl>
    </div>
  );
}

function ScoreCard({ score }: { score: ScorePayload | null }) {
  if (!score) return <p className="text-sm text-subtle">正在算成绩…</p>;
  return (
    <dl className="flex flex-col gap-2 text-sm">
      <Row label="CER 最终文字" value={fmtCer(score.cerFinal)} main />
      <Row label="CER 仅 xAI" value={fmtCer(score.cerXai)} />
      <Row
        label="CER 仅 Apple"
        value={
          score.liveHasData
            ? `${fmtCer(score.cerLive)} · 空 ${(score.liveEmptyRate * 100).toFixed(0)}%`
            : `无数据 · 空 ${(score.liveEmptyRate * 100).toFixed(0)}%`
        }
      />
      <Row label="完全正确率" value={fmtPct(score.exactMatch)} />
      <Row label={`声学标签 · ${TAG_LABELS.length}`} value={fmtPct(score.tagAccuracy.length)} />
      <Row label={`声学标签 · ${TAG_LABELS.contour}`} value={fmtPct(score.tagAccuracy.contour)} />
      <Row label={`声学标签 · ${TAG_LABELS.voice}`} value={fmtPct(score.tagAccuracy.voice)} />
      {TAG_EVENT_VALUES.map((event) => (
        <Row
          key={event}
          label={`声学标签 · ${TAG_VALUE_LABELS.events[event]}`}
          value={fmtEventPr(score.tagAccuracy.events[event])}
        />
      ))}
      <Row
        label="噪音里有字"
        value={
          score.noiseN === 0 ? "无数据" : `${fmtPct(score.noiseRecognizedRate)} · ${score.noiseN} 条`
        }
      />
      <Row
        label="疑似幻觉"
        value={
          score.hallucinationN === 0
            ? "0"
            : `${score.hallucinationN}（apple_empty ${score.hallucinationByReason?.apple_empty ?? 0} · short_quiet ${score.hallucinationByReason?.short_quiet ?? 0}）`
        }
      />
      <Row label="引擎占比" value={formatEngineMix(score.engineUse)} />
    </dl>
  );
}

function Row({ label, value, main }: { label: string; value: string; main?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={main ? "font-medium" : ""}>{value}</dd>
    </div>
  );
}

function fmtCer(n: number | null) {
  if (n == null) return "无数据";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtPct(n: number | null) {
  if (n == null) return "无数据";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtEventPr(row: EventPr | undefined) {
  if (!row || (row.precision == null && row.recall == null)) return "无数据";
  return `P ${fmtPct(row.precision)} · R ${fmtPct(row.recall)}`;
}

function isEmotion(value: string | null | undefined): value is CueEmotion {
  return typeof value === "string" && (EMOTIONS as readonly string[]).includes(value);
}

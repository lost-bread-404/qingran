import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmTurn } from "@/components/lover/confirm-turn";
import {
  backfillHearingProsody,
  confirmHearingClip,
  deleteHearingClip,
  exportHearingClips,
  exportReplyFlags,
  getHearingClipAudio,
  hearingLabScore,
  listHearingConfusionRules,
  listLabeledHearingClips,
  listReplyFlags,
  rebuildHearingConfusionRules,
  setHearingConfusionEnabled,
  tuneHearingTone,
  unlabelHearingClip,
  unlockHearingLab,
  type ConfusionRule,
  type LabeledClipRow,
  type ReplyFlagRow,
} from "@/lib/lover/hearing/store";
import {
  listStoryMemory,
  previewStorySeed,
} from "@/lib/lover/brain/story";
import {
  exportTurnFeedbackFn,
  listTurnFeedbackFn,
} from "@/lib/lover/brain/turn-trace-fn";
import type { TurnFeedbackRow } from "@/lib/lover/brain/turn-trace";
import { CONFUSION_MIN_COUNT } from "@/lib/lover/hearing/confusions";
import { formatClipVoiceLine } from "@/lib/lover/hearing/night-voice";
import { formatToneReadingLine } from "@/lib/lover/hearing/sense";
import { EMOTIONS, type CueEmotion } from "@/lib/lover/hearing/schema";
import type { HearingScore, ScoreWindow, WorstClip } from "@/lib/lover/hearing/score";
import type { AcousticTags } from "@/lib/lover/hearing/tags";
import { countReplyDownTags, type ReplyDownTag } from "@/lib/lover/reply-feedback";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/lab")({ component: HearingLabPage });

const LAB_KEY = "qingran-hearing-lab";


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
  const [confusions, setConfusions] = useState<ConfusionRule[]>([]);
  const [prosodyStatus, setProsodyStatus] = useState<string | null>(null);
  const [tuneStatus, setTuneStatus] = useState<string | null>(null);
  const [labTab, setLabTab] = useState<"hearing" | "memory" | "feedback">("hearing");
  const [storyNotes, setStoryNotes] = useState<
    Array<{
      id: string;
      text: string;
      tags: string[];
      subject: string;
      lens: string[];
      fromRosie: boolean;
      weight: number;
      happenedAt: number;
      localDay: string;
      links: string[];
    }>
  >([]);
  const [storyPortrait, setStoryPortrait] = useState<
    Array<{ id: string; topic: string; body: string; status: string }>
  >([]);
  const [feedbackRows, setFeedbackRows] = useState<TurnFeedbackRow[]>([]);
  const [feedbackOpen, setFeedbackOpen] = useState<string | null>(null);
  const [feedbackTag, setFeedbackTag] = useState<ReplyDownTag | null>(null);
  const tagCounts = countReplyDownTags(feedbackRows);
  const shownFeedback = feedbackTag
    ? feedbackRows.filter((row) => row.tags.includes(feedbackTag))
    : feedbackRows;

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

  async function loadConfusions(secret = password) {
    try {
      const next = await listHearingConfusionRules({ data: { password: secret } });
      if (!next.ok) {
        setStatus(next.error);
        return;
      }
      setConfusions(next.rules);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadMemory(secret = password) {
    try {
      const next = await listStoryMemory({ data: { password: secret } });
      if (!next.ok) {
        setStatus(next.error);
        return;
      }
      setStoryNotes(next.notes);
      setStoryPortrait(next.portrait);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadFeedback(secret = password) {
    try {
      const next = await listTurnFeedbackFn({ data: { password: secret } });
      if (!next.ok) {
        setStatus(next.error);
        return;
      }
      setFeedbackRows(next.rows);
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
      await loadConfusions(secret);
      await loadMemory(secret);
      await loadFeedback(secret);
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
          <p className="font-display text-lg">
            {labTab === "hearing" ? "成绩" : labTab === "memory" ? "记忆" : "反馈"}
          </p>
          <p className="text-xs text-subtle">
            {labTab === "hearing"
              ? score
                ? `${score.clipN} 段 · 有 gold ${score.goldN}`
                : "读取数据库…"
              : labTab === "memory"
                ? `${storyNotes.length} 条笔记 · ${storyPortrait.length} 条画像`
                : feedbackTag
                  ? `${shownFeedback.length} 条 · ${feedbackTag}`
                  : `${feedbackRows.length} 条反馈`}
            {score?.dbSource && labTab === "hearing" ? ` · ${score.dbSource}` : ""}
          </p>
        </div>
      </header>

      <div className="flex shrink-0 gap-2 px-4 pb-3">
        {(
          [
            ["hearing", "听力"],
            ["memory", "记忆"],
            ["feedback", "反馈"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setLabTab(id)}
            className={cn(
              "min-h-11 flex-1 rounded-md text-sm",
              labTab === id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? <p className="mx-4 mb-2 text-sm text-live">{error}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
          {labTab === "hearing" ? (
          <>
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
            {score?.recentFloors.length ? (
              <p className="mt-3 text-xs leading-relaxed text-subtle">
                最近底噪 {score.recentFloors.map((row) => row.vadFloor.toFixed(3)).join(" → ")}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  setProsodyStatus("正在回填韵律…");
                  try {
                    let total = 0;
                    for (let i = 0; i < 20; i += 1) {
                      const next = await backfillHearingProsody({ data: { password } });
                      total += next.filled;
                      setProsodyStatus(`已回填 ${next.filled} 条，剩余 ${next.missing}。`);
                      if (!next.missing || !next.processed) break;
                    }
                    setStatus(`韵律回填完成，本轮写入 ${total} 条。`);
                  } catch (err) {
                    setProsodyStatus(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                回填韵律
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  setTuneStatus("正在离线回放…");
                  try {
                    const next = await tuneHearingTone({ data: { password } });
                    setTuneStatus(
                      `语气符号 ${next.clipN} 条 · 默认 ${(next.defaultScore.accuracy * 100).toFixed(0)}% · 最优 ${(next.bestScore.accuracy * 100).toFixed(0)}%（rise ${next.best.riseQuestion} / glide ${next.best.glideRatio} / fade ${next.best.fadeRatio} / long ${next.best.longDur}）`,
                    );
                  } catch (err) {
                    setTuneStatus(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                离线调阈值
              </Button>
            </div>
            {prosodyStatus ? <p className="mt-2 text-xs text-subtle">{prosodyStatus}</p> : null}
            {tuneStatus ? <p className="mt-1 text-xs text-subtle">{tuneStatus}</p> : null}
          </section>

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
                      {row.vadFloor != null ? ` · 底噪 ${row.vadFloor.toFixed(3)}` : ""}
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
                      {row.vadFloor != null ? ` · 底噪 ${row.vadFloor.toFixed(3)}` : ""}
                      {` · ${formatClipVoiceLine(row)}`}
                      {` · ${formatToneReadingLine(row)}`}
                      {row.senseLine ? ` · ${row.senseLine}` : ""}
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
            <p className="mb-2 font-display text-lg">同音词</p>
            <p className="mb-3 text-xs text-subtle">
              从 ✎ edited 标注自动抽「错→对」。出现 ≥ {CONFUSION_MIN_COUNT} 次且未关闭的会在 STT 后替换。
            </p>
            <div className="mb-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    const next = await rebuildHearingConfusionRules({ data: { password } });
                    setConfusions(next.rules);
                    setStatus(`已重算同音词 ${next.rules.length} 条。`);
                  } catch (err) {
                    setStatus(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                重算同音词
              </Button>
            </div>
            {confusions.length ? (
              <ul className="flex flex-col gap-2">
                {confusions.map((rule) => {
                  const active = rule.enabled && rule.count >= CONFUSION_MIN_COUNT;
                  return (
                    <li key={rule.id} className="rounded-md bg-surface-2 px-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm">
                            {rule.wrong} → {rule.correct}
                            <span className="ml-2 text-xs text-subtle">
                              {rule.count} 次{active ? " · 生效" : " · 未生效"}
                            </span>
                          </p>
                          {rule.examples[0] ? (
                            <p className="mt-1 text-xs text-subtle">
                              例 {rule.examples[0].hyp} → {rule.examples[0].gold}
                            </p>
                          ) : null}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={async () => {
                            try {
                              const next = await setHearingConfusionEnabled({
                                data: { password, id: rule.id, enabled: !rule.enabled },
                              });
                              setConfusions(next.rules);
                            } catch (err) {
                              setStatus(err instanceof Error ? err.message : String(err));
                            }
                          }}
                        >
                          {rule.enabled ? "关闭" : "打开"}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-subtle">还没有从 edited 标注抽出的词对。</p>
            )}
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
                    {row.tags.length ? <p className="mt-1 text-xs text-subtle">{row.tags.join(" · ")}</p> : null}
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
          </>
          ) : labTab === "memory" ? (
            <>
              <section className="rounded-md bg-surface-2 px-3 py-3">
                <p className="mb-2 font-display text-lg">导入故事线</p>
                <p className="text-sm text-muted">
                  故事线不再写入笔记和画像。种子只在第一次整理「我记得的」时用。这里只显示种子里有多少条。
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3"
                  onClick={async () => {
                    const preview = await previewStorySeed({ data: { password } });
                    if (!preview.ok) {
                      setStatus(preview.error);
                      return;
                    }
                    setStatus(`种子里有 ${preview.notes} 条事件、${preview.portrait} 条画像。不再写入笔记和画像。`);
                  }}
                >
                  看种子有多少
                </Button>
              </section>
              <section>
                <p className="mb-2 font-display text-lg">画像</p>
                {!storyPortrait.length ? (
                  <p className="text-sm text-subtle">还没有画像。导入故事线后会出现。</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {storyPortrait.map((row) => (
                      <li key={row.id} className="rounded-md bg-surface-2 px-3 py-3">
                        <p className="text-xs text-subtle">{row.topic}</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{row.body}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <p className="mb-2 font-display text-lg">事件</p>
                {!storyNotes.length ? (
                  <p className="text-sm text-subtle">还没有笔记。</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {storyNotes.map((row) => (
                      <li key={row.id} className="rounded-md bg-surface-2 px-3 py-3">
                        <p className="text-xs text-subtle">
                          {row.localDay} · {row.subject} · {row.lens.join("/")} · {row.weight}
                          {row.fromRosie ? " · Rosie" : ""}
                        </p>
                        <p className="mt-1 text-sm">{row.text}</p>
                        {row.tags.length ? (
                          <p className="mt-1 text-xs text-subtle">{row.tags.join(" · ")}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : (
            <>
              <section>
                <p className="mb-2 font-display text-lg">反馈</p>
                <p className="mb-3 text-xs text-subtle">
                  {feedbackRows.length
                    ? "按标签筛选。点开看这一轮检索、内心和回复。"
                    : "还没有反馈。"}
                </p>
                {feedbackRows.length ? (
                  <div className="mb-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      aria-pressed={feedbackTag == null}
                      onClick={() => setFeedbackTag(null)}
                      className={cn(
                        "min-h-11 rounded-md px-3 text-sm",
                        feedbackTag == null ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
                      )}
                    >
                      全部 {feedbackRows.length}
                    </button>
                    {tagCounts.map(({ tag, n }) => (
                      <button
                        key={tag}
                        type="button"
                        aria-pressed={feedbackTag === tag}
                        onClick={() => setFeedbackTag(feedbackTag === tag ? null : tag)}
                        className={cn(
                          "min-h-11 rounded-md px-3 text-sm",
                          feedbackTag === tag ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
                        )}
                      >
                        {tag} {n}
                      </button>
                    ))}
                  </div>
                ) : null}
                {shownFeedback.length ? (
                  <ul className="flex flex-col gap-3">
                    {shownFeedback.map((row) => {
                      const open = feedbackOpen === row.id;
                      const replyText =
                        row.trace && row.trace.reply && typeof row.trace.reply === "object"
                          ? String((row.trace.reply as { text?: string }).text ?? "")
                          : "";
                      const retrieve = Array.isArray(
                        row.trace && typeof row.trace.retrieve === "object"
                          ? (row.trace.retrieve as { items?: unknown }).items
                          : null,
                      )
                        ? ((row.trace!.retrieve as { items: Array<{ id: string; title: string; reason: string; score: number | null }> }).items)
                        : [];
                      const mind =
                        row.trace && row.trace.reflector && typeof row.trace.reflector === "object"
                          ? (row.trace.reflector as { mind?: unknown; model?: string; ms?: number })
                          : null;
                      return (
                        <li key={row.id} className="rounded-md bg-surface-2 px-3 py-3">
                          <button
                            type="button"
                            className="w-full text-left"
                            onClick={() => setFeedbackOpen(open ? null : row.id)}
                          >
                            <p className="text-xs text-subtle">
                              {row.rating === "up"
                                ? "👍"
                                : row.tags.length
                                  ? row.tags.join(" · ")
                                  : "差"}{" "}
                              · {row.createdAt}
                              {row.turnId ? ` · ${row.turnId.slice(0, 8)}` : ""}
                            </p>
                            {row.note ? <p className="mt-1 text-sm">{row.note}</p> : null}
                            {replyText ? (
                              <p className="mt-1 line-clamp-2 text-sm text-muted">{replyText}</p>
                            ) : null}
                          </button>
                          {open ? (
                            <div className="mt-3 flex flex-col gap-2 border-t border-bg pt-3 text-sm">
                              <p className="text-xs text-subtle">检索</p>
                              {retrieve.length ? (
                                retrieve.map((item) => (
                                  <p key={item.id} className="text-xs">
                                    {item.reason} · {item.title}
                                    {item.score != null ? ` · ${item.score}` : ""}
                                  </p>
                                ))
                              ) : (
                                <p className="text-xs text-subtle">没有检索记录。</p>
                              )}
                              <p className="mt-2 text-xs text-subtle">
                                内心 {mind?.model ?? ""} {mind?.ms != null ? `· ${mind.ms}ms` : ""}
                              </p>
                              <pre className="whitespace-pre-wrap break-words text-xs text-muted">
                                {mind?.mind ? JSON.stringify(mind.mind, null, 2) : "还没有 Reflector 输出。"}
                              </pre>
                              <p className="mt-2 text-xs text-subtle">回复</p>
                              <p className="whitespace-pre-wrap text-sm">{replyText || "（空）"}</p>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : feedbackRows.length ? (
                  <p className="text-sm text-subtle">这个标签还没有反馈。</p>
                ) : null}
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        const exported = await exportTurnFeedbackFn({ data: { password } });
                        const blob = new Blob([`${JSON.stringify(exported, null, 2)}\n`], {
                          type: "application/json",
                        });
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = `qingran-feedback-${new Date().toISOString().slice(0, 10)}.json`;
                        link.click();
                        URL.revokeObjectURL(url);
                        setStatus("已导出反馈 JSON。");
                      } catch (err) {
                        setStatus(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  >
                    导出 JSON
                  </Button>
                </div>
              </section>
            </>
          )}
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
      <Row label="语气符号准确率" value={fmtPct(score.toneAccuracy)} />
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

function isEmotion(value: string | null | undefined): value is CueEmotion {
  return typeof value === "string" && (EMOTIONS as readonly string[]).includes(value);
}

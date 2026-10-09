import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { exportTurnFeedbackFn, listTurnFeedbackFn } from "@/lib/lover/brain/turn-feedback-fn";
import type { TurnFeedbackRow } from "@/lib/lover/brain/turn-feedback";
import { unlockLab } from "@/lib/lover/lab";
import { countReplyDownTags, type ReplyDownTag } from "@/lib/lover/reply-feedback";
import { checkSpeechTag, type ToneResult } from "@/lib/lover/tone-check";
import { TONE_CASES } from "@/lib/lover/tone-cases";
import { cn } from "@/lib/utils";

/**
 * 实验室 (设置 → 高级 → 实验室): her feedback on his replies (thumbs, 差在哪, corrections), and Eve's voice tags read one
 * at a time. Hearing is no longer labelled here (requirements 第 7 节): her own corrections are the record.
 */
export const Route = createFileRoute("/lab")({ component: LabPage });

const LAB_KEY = "qingran-hearing-lab";

function LabPage() {
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [labTab, setLabTab] = useState<"feedback" | "tone">("feedback");
  const [feedbackRows, setFeedbackRows] = useState<TurnFeedbackRow[]>([]);
  const [feedbackOpen, setFeedbackOpen] = useState<string | null>(null);
  const [feedbackTag, setFeedbackTag] = useState<ReplyDownTag | null>(null);
  const tagCounts = countReplyDownTags(feedbackRows);
  const shownFeedback = feedbackTag ? feedbackRows.filter((row) => row.tags.includes(feedbackTag)) : feedbackRows;

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

  async function unlock() {
    setError(null);
    try {
      const result = await unlockLab({ data: { password } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      sessionStorage.setItem(LAB_KEY, password);
      setUnlocked(true);
      await loadFeedback(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    const saved = sessionStorage.getItem(LAB_KEY);
    if (!saved) return;
    setPassword(saved);
    void unlockLab({ data: { password: saved } }).then((result) => {
      if (!result.ok) return;
      setUnlocked(true);
      void loadFeedback(saved);
    });
  }, []);

  if (!unlocked) {
    return (
      <div className="flex h-full flex-col bg-bg">
        <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <Link to="/" className="text-sm text-muted">
            返回
          </Link>
        </header>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6">
          <p className="font-display text-2xl">实验室</p>
          <p className="max-w-sm text-center text-sm text-muted">反馈和语气标签，需要密码。</p>
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
          <p className="font-display text-lg">{labTab === "feedback" ? "反馈" : "Eve 语气标签"}</p>
          <p className="text-xs text-subtle">
            {labTab === "feedback"
              ? feedbackTag
                ? `${shownFeedback.length} 条 · ${feedbackTag}`
                : `${feedbackRows.length} 条反馈`
              : `${TONE_CASES.length} 种读法`}
          </p>
        </div>
      </header>

      <div className="flex shrink-0 gap-2 px-4 pb-3">
        {(
          [
            ["feedback", "反馈"],
            ["tone", "语气标签"],
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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
          {labTab === "tone" ? (
            <ToneCheck password={password} />
          ) : (
            <section>
              <p className="mb-3 text-xs text-subtle">
                {feedbackRows.length ? "按标签筛选。点开看这一轮想起来的回忆和回复。" : "还没有反馈。"}
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
                    return (
                      <li key={row.id} className="rounded-md bg-surface-2 px-3 py-3">
                        <button
                          type="button"
                          className="w-full text-left"
                          onClick={() => setFeedbackOpen(open ? null : row.id)}
                        >
                          <p className="text-xs text-subtle">
                            {row.rating === "up" ? "👍" : row.tags.length ? row.tags.join(" · ") : "差"} · {row.createdAt}
                          </p>
                          {row.note ? <p className="mt-1 whitespace-pre-wrap text-sm">{row.note}</p> : null}
                          {row.reply ? <p className="mt-1 line-clamp-2 text-sm text-muted">{row.reply}</p> : null}
                        </button>
                        {open ? (
                          <div className="mt-3 flex flex-col gap-2 border-t border-bg pt-3 text-sm">
                            <p className="text-xs text-subtle">想起来的</p>
                            {row.recalled.length ? (
                              row.recalled.map((text, i) => (
                                <p key={i} className="text-xs">
                                  {text}
                                </p>
                              ))
                            ) : (
                              <p className="text-xs text-subtle">这一句没有想起什么。</p>
                            )}
                            <p className="mt-2 text-xs text-subtle">回复</p>
                            <p className="whitespace-pre-wrap text-sm">{row.reply || "（空）"}</p>
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
                      const blob = new Blob([`${JSON.stringify(exported, null, 2)}\n`], { type: "application/json" });
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
                {status ? <p className="mt-2 text-sm text-subtle">{status}</p> : null}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** 语气标签有没有用：xAI 列出的每个标签，同一句话，点哪个读哪个，听一听、看音量和 xAI 听到的字。 */
function ToneCheck({ password }: { password: string }) {
  const [rows, setRows] = useState<Record<string, ToneResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const r = await checkSpeechTag({ data: { password, id } });
      setRows((prev) => ({ ...prev, [id]: r }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="rounded-md bg-surface-2 px-3 py-3">
      {error ? <p className="text-sm text-live">{error}</p> : null}
      <ul className="flex flex-col gap-3">
        {TONE_CASES.map((c) => {
          const r = rows[c.id];
          return (
            <li key={c.id} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm">{c.how}</p>
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void read(c.id)}>
                  {busy === c.id ? "在读…" : r ? "再读" : "读"}
                </Button>
              </div>
              {r ? (
                r.error ? (
                  <p className="text-live">{r.error}</p>
                ) : (
                  <>
                    <p className="text-subtle">
                      {r.sec} 秒（有声 {r.voicedSec} 秒）· 音量 {r.loudness} · 听到：{r.heard}
                    </p>
                    {r.wav ? (
                      <audio controls autoPlay preload="none" src={`data:audio/wav;base64,${r.wav}`} className="mt-1 w-full" />
                    ) : null}
                  </>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

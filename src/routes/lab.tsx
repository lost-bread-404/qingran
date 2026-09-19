import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmTurn } from "@/components/lover/confirm-turn";
import {
  confirmHearingClip,
  deleteHearingClip,
  exportHearingClips,
  getHearingClipAudio,
  hearingLabScore,
  unlockHearingLab,
} from "@/lib/lover/hearing/store";
import { EMOTIONS, type CueEmotion } from "@/lib/lover/hearing/schema";
import type { HearingScore, ScoreWindow, WorstClip } from "@/lib/lover/hearing/score";
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

function HearingLabPage() {
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowId, setWindowId] = useState<ScoreWindow>("7d");
  const [score, setScore] = useState<ScorePayload | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [editClip, setEditClip] = useState<WorstClip | null>(null);
  const [editAudio, setEditAudio] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);

  async function load(secret = password, nextWindow = windowId) {
    try {
      const next = await hearingLabScore({ data: { password: secret, window: nextWindow } });
      if (!next.ok) {
        setError(next.error);
        setScore(next);
        return;
      }
      setError(null);
      setScore(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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
      await load(password, windowId);
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
      void load(saved, windowId);
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

  if (!unlocked) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
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
        <Link to="/" className="text-sm text-subtle">
          回通话
        </Link>
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
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          if (playUrl) URL.revokeObjectURL(playUrl);
                          const result = await getHearingClipAudio({ data: { password, id: row.id } });
                          if (!result.ok) {
                            setStatus(result.error);
                            return;
                          }
                          const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
                          const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
                          setPlayUrl(url);
                          const audio = new Audio(url);
                          void audio.play();
                        }}
                      >
                        播放
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => {
                        setEditError(null);
                        setEditClip(row);
                      }}>
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
        audioUrl={editAudio}
        busy={editBusy}
        error={editError}
        initialNoise={Boolean(editClip?.noiseOnly)}
        initialLiteralMismatch={Boolean(editClip?.literalMismatch)}
        initialToneNote={editClip?.toneNote ?? ""}
        onClose={() => {
          setEditClip(null);
          setEditError(null);
        }}
        onConfirm={async ({ goldText, source, noiseOnly, literalMismatch, toneNote }) => {
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
      <Row label="疑似幻觉" value={`${score.hallucinationN}`} />
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

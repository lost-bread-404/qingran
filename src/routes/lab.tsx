import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  assignHearingSplits,
  deleteHearingClip,
  exportHearingClips,
  getHearingClipAudio,
  listHearingClips,
  saveHearingGold,
  unlockHearingLab,
} from "@/lib/lover/hearing/store";
import { EMOTIONS, type HearingCue, type HearingResult } from "@/lib/lover/hearing/schema";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/lab")({ component: HearingLabPage });

type ClipRow = {
  id: string;
  createdAt: string;
  durationMs: number;
  source: string;
  category: string | null;
  split: string | null;
  xaiText: string;
  hearingText: string;
  hearing: HearingResult | null;
  liveText: string;
  goldText: string;
  goldCues: HearingCue[];
  noiseOnly: boolean;
  skip: boolean;
  hasGold: boolean;
  hasRelabel: boolean;
};

const LAB_KEY = "qingran-hearing-lab";

function HearingLabPage() {
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clips, setClips] = useState<ClipRow[]>([]);
  const [index, setIndex] = useState(0);
  const [relabel, setRelabel] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [goldText, setGoldText] = useState("");
  const [goldCuesText, setGoldCuesText] = useState("[]");
  const [noiseOnly, setNoiseOnly] = useState(false);
  const [skip, setSkip] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const clip = clips[index] ?? null;

  async function load(nextRelabel = relabel, secret = password) {
    const listed = await listHearingClips({ data: { password: secret, relabel: nextRelabel } });
    setClips(listed.clips as ClipRow[]);
    setIndex(0);
  }

  async function unlock() {
    setError(null);
    const result = await unlockHearingLab({ data: { password } });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    sessionStorage.setItem(LAB_KEY, password);
    setUnlocked(true);
    await load(relabel, password);
  }

  useEffect(() => {
    const saved = sessionStorage.getItem(LAB_KEY);
    if (!saved) return;
    setPassword(saved);
    void unlockHearingLab({ data: { password: saved } }).then((result) => {
      if (!result.ok) return;
      setUnlocked(true);
      void load(false, saved);
    });
  }, []);

  useEffect(() => {
    if (!clip || !unlocked) {
      setGoldText("");
      setGoldCuesText("[]");
      setNoiseOnly(false);
      setSkip(false);
      setAudioUrl(null);
      return;
    }
    setGoldText(clip.goldText);
    setGoldCuesText(JSON.stringify(clip.goldCues, null, 2));
    setNoiseOnly(clip.noiseOnly);
    setSkip(clip.skip);
    let revoked = false;
    void getHearingClipAudio({ data: { password, id: clip.id } }).then((result) => {
      if (!result.ok || revoked) return;
      const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      setAudioUrl(url);
    });
    return () => {
      revoked = true;
    };
  }, [clip?.id, unlocked, password]);

  const hearingPreview = useMemo(() => {
    if (!clip?.hearing || typeof clip.hearing !== "object") return "";
    try {
      return JSON.stringify(clip.hearing, null, 2);
    } catch {
      return "";
    }
  }, [clip]);

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
          <p className="font-display text-lg">标注</p>
          <p className="text-xs text-subtle">
            {clips.length} 段 · {index + 1}/{Math.max(clips.length, 1)}
            {relabel ? " · 重标" : ""}
          </p>
        </div>
        <Button
          type="button"
          variant={relabel ? "default" : "outline"}
          size="sm"
          onClick={() => {
            const next = !relabel;
            setRelabel(next);
            void load(next);
          }}
        >
          重标
        </Button>
      </header>

      <div className="flex shrink-0 gap-2 overflow-x-auto px-4 pb-3">
        <Button type="button" variant="outline" size="sm" disabled={!clip} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
          上一段
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!clip}
          onClick={() => setIndex((i) => Math.min(clips.length - 1, i + 1))}
        >
          下一段
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            const result = await assignHearingSplits({ data: { password } });
            setStatus(`已按类别分层分好 ${result.assigned} 段（70/30）。`);
            await load();
          }}
        >
          分配 dev/test
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            const exported = await exportHearingClips({ data: { password } });
            const blob = new Blob([`${JSON.stringify(exported)}\n`], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `qingran-hearing-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            URL.revokeObjectURL(url);
            setStatus("已导出 JSON。");
          }}
        >
          导出 JSON
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {!clip ? (
          <p className="text-sm text-subtle">还没有录音。打开设置里的录音采集后再通话。</p>
        ) : (
          <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
            <div className="rounded-md bg-surface-2 px-3 py-2 text-sm">
              <p>
                {clip.source} · {clip.category || "未分类"} · {clip.split || "未分"} · {clip.durationMs}ms
              </p>
              {audioUrl ? (
                <audio className="mt-2 w-full" controls src={audioUrl} />
              ) : (
                <p className="mt-2 text-xs text-subtle">正在取录音…</p>
              )}
            </div>
            <Field label="xAI STT" value={clip.xaiText} />
            <Field label="Hearing" value={clip.hearingText} />
            <Field label="Web Speech" value={clip.liveText} />
            {hearingPreview ? (
              <pre className="max-h-40 overflow-auto rounded-md bg-surface-2 p-3 text-xs text-muted">
                {hearingPreview}
              </pre>
            ) : null}
            <label className="flex flex-col gap-1 text-sm">
              gold_text
              <Textarea value={goldText} onChange={(e) => setGoldText(e.target.value)} className="min-h-24" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              gold_cues（JSON）
              <Textarea
                value={goldCuesText}
                onChange={(e) => setGoldCuesText(e.target.value)}
                className="min-h-32 font-mono text-xs"
              />
            </label>
            <p className="text-xs text-subtle">emotion: {EMOTIONS.join(" / ")}</p>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={noiseOnly} onChange={(e) => setNoiseOnly(e.target.checked)} />
              noise_only
            </label>
            {relabel ? null : (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
                skip
              </label>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={async () => {
                  let cues: HearingCue[] = [];
                  try {
                    const parsed = JSON.parse(goldCuesText) as unknown;
                    cues = Array.isArray(parsed) ? (parsed as HearingCue[]) : [];
                  } catch {
                    setStatus("cues 不是合法 JSON。");
                    return;
                  }
                  await saveHearingGold({
                    data: {
                      password,
                      id: clip.id,
                      relabel,
                      goldText,
                      goldCues: cues,
                      noiseOnly,
                      skip,
                    },
                  });
                  setStatus(relabel ? "重标已另存。" : "已保存标注。");
                  await load();
                }}
              >
                保存
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  if (!window.confirm("删掉这段录音？")) return;
                  await deleteHearingClip({ data: { password, id: clip.id } });
                  setStatus("已删除。");
                  await load();
                }}
              >
                删除
              </Button>
            </div>
            {status ? <p className="text-sm text-subtle">{status}</p> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-subtle">{label}</p>
      <p className={cn("text-sm", value ? "text-fg" : "text-subtle")}>{value || "（空）"}</p>
    </div>
  );
}

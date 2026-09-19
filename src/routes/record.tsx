import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { MicButton } from "@/components/lover/mic-button";
import { Button } from "@/components/ui/button";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { clipSaveBanner } from "@/lib/lover/hearing/heard";
import { SCRIPTED_CATEGORIES, type ScriptedCategoryId } from "@/lib/lover/hearing/config";
import {
  bumpScriptedCount,
  countsFromQuotaRows,
  nextScriptedCategory,
  sanitizeSkipped,
} from "@/lib/lover/hearing/scripted";
import { loadRoom, saveRoomProfile } from "@/lib/lover/room";
import { saveHearingClip, scriptedQuota, undoHearingClip } from "@/lib/lover/hearing/store";
import { blobToBase64 } from "@/lib/lover/audio";
import { lockedProfile } from "@/lib/lover/types";
import { newId } from "@/lib/lover/storage";

export const Route = createFileRoute("/record")({ component: RecordPage });

type LastTake = {
  clipId: string;
  category: ScriptedCategoryId;
  label: string;
  have: number;
  quota: number;
  audioUrl: string;
};

function RecordPage() {
  const voice = useVoiceInput({ lang: "zh-CN" });
  const [have, setHave] = useState<Record<string, number>>({});
  const [skipped, setSkipped] = useState<ScriptedCategoryId[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<LastTake | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const profileRef = useRef(lockedProfile());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const current = nextScriptedCategory(have, skipped);

  const persistSkip = useCallback(async (nextSkip: ScriptedCategoryId[]) => {
    const profile = lockedProfile({ ...profileRef.current, skippedScripted: nextSkip });
    profileRef.current = profile;
    await saveRoomProfile({ data: profile });
  }, []);

  const refreshQuota = useCallback(async () => {
    const result = await scriptedQuota();
    const counts = countsFromQuotaRows(result.categories);
    setHave(counts);
    return counts;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadRoom()
      .then((room) => {
        if (cancelled) return;
        profileRef.current = lockedProfile(room.profile);
        setSkipped(sanitizeSkipped(room.profile.skippedScripted));
        setHydrated(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setHydrated(true);
      });
    void refreshQuota();
    return () => {
      cancelled = true;
    };
  }, [refreshQuota]);

  useEffect(() => {
    return () => {
      if (last?.audioUrl) URL.revokeObjectURL(last.audioUrl);
    };
  }, [last?.audioUrl]);

  const recording = voice.status === "recording";
  const transcribing = busy;

  const holdStart = useCallback(async () => {
    if (busy || transcribing || !current || last) return;
    setError(null);
    await voice.start();
  }, [busy, current, last, transcribing, voice]);

  const holdEnd = useCallback(async () => {
    if (!current) return;
    const category = current;
    const collected = await voice.stopRaw();
    const clip =
      collected?.wav && collected.wav.size >= 80
        ? collected.wav
        : collected?.fallback && collected.fallback.size >= 40
          ? collected.fallback
          : null;
    if (!clip) {
      setError("没有录到声音，按住再试一次。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const audioBase64 = await blobToBase64(clip);
      const turnId = newId();
      const result = await saveHearingClip({
        data: {
          audioBase64,
          liveText: collected?.liveText ?? "",
          source: "scripted",
          category: category.id,
          turnId,
          mode: "scripted",
        },
      });
      if (!result.ok) {
        setError(clipSaveBanner(result.error));
        return;
      }
      const localUrl = URL.createObjectURL(clip);
      const bumped = bumpScriptedCount(have, category.id);
      setHave(bumped);
      const fresh = await refreshQuota();
      const haveNow = fresh[category.id] ?? bumped[category.id] ?? 0;
      setLast((prev) => {
        if (prev?.audioUrl) URL.revokeObjectURL(prev.audioUrl);
        return {
          clipId: result.clipId,
          category: category.id,
          label: category.label,
          have: haveNow,
          quota: category.quota,
          audioUrl: localUrl,
        };
      });
    } catch (err) {
      setError(clipSaveBanner(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }, [current, have, refreshQuota, voice]);

  async function redo() {
    if (!last) return;
    setBusy(true);
    try {
      await undoHearingClip({ data: { id: last.clipId } });
      setLast((prev) => {
        if (prev?.audioUrl) URL.revokeObjectURL(prev.audioUrl);
        return null;
      });
      const fresh = await refreshQuota();
      setHave(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function replay() {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    void el.play();
  }

  async function skipCurrent() {
    const id = last?.category ?? current?.id;
    if (!id) return;
    setLast((prev) => {
      if (prev?.audioUrl) URL.revokeObjectURL(prev.audioUrl);
      return null;
    });
    const next = skipped.includes(id) ? skipped : [...skipped, id];
    setSkipped(next);
    await persistSkip(next);
    const fresh = await refreshQuota();
    setHave(fresh);
  }

  async function restore(id: ScriptedCategoryId) {
    const next = skipped.filter((item) => item !== id);
    setSkipped(next);
    await persistSkip(next);
  }

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">打开定向录制…</div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link to="/" className="text-sm text-muted">
          返回
        </Link>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg">定向录制</p>
          <p className="text-xs text-subtle">按住录、松开存。不发给清然，不跑识别。</p>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {current ? (
          <div className="rounded-md bg-surface-2 px-4 py-4">
            <p className="font-display text-2xl leading-tight">
              {current.label}
              <span className="ml-2 font-sans text-sm text-subtle">
                {have[current.id] ?? 0}/{current.quota}
              </span>
            </p>
            <p className="mt-2 text-sm text-muted">{current.hint}</p>
            <p className="mt-2 text-sm text-fg">例：{current.example}</p>
          </div>
        ) : (
          <div className="rounded-md bg-surface-2 px-4 py-4 text-sm text-muted">
            定向录制做完了。下面可以恢复跳过的类别。
          </div>
        )}

        {(error || voice.error) && (
          <p className="mt-3 text-sm text-live">{error || voice.error}</p>
        )}

        {last ? (
          <div className="mt-4 rounded-md bg-surface-2 px-4 py-3">
            <p className="text-sm">
              已录 · {last.label} {last.have}/{last.quota}
            </p>
            <audio ref={audioRef} className="mt-2 w-full" controls src={last.audioUrl} />
            <div className="mt-3 flex flex-col gap-2">
              <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={replay}>
                重听
              </Button>
              <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void redo()}>
                重录
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() =>
                  setLast((prev) => {
                    if (prev?.audioUrl) URL.revokeObjectURL(prev.audioUrl);
                    return null;
                  })
                }
              >
                下一条
              </Button>
              <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void skipCurrent()}>
                跳过此类别
              </Button>
            </div>
          </div>
        ) : current ? (
          <div className="mt-4 flex justify-end">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void skipCurrent()}>
              跳过此类别
            </Button>
          </div>
        ) : null}

        {skipped.length > 0 ? (
          <div className="mt-4 rounded-md bg-surface-2 px-4 py-3">
            <p className="text-sm">跳过的类别</p>
            <ul className="mt-2 flex flex-col gap-2">
              {skipped.map((id) => (
                <li key={id} className="flex items-center justify-between gap-2">
                  <span className="text-sm">
                    {SCRIPTED_CATEGORIES.find((c) => c.id === id)?.label ?? id}
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={() => void restore(id)}>
                    恢复
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-auto flex flex-col items-center gap-3 pt-6">
          <MicButton
            recording={recording}
            busy={transcribing}
            level={voice.level}
            disabled={!current || transcribing || Boolean(last)}
            onHoldStart={() => void holdStart()}
            onHoldEnd={() => void holdEnd()}
            ariaLabel={recording ? "松开结束录音" : "按住录音"}
          />
          <p className="min-h-4 max-w-xs text-center text-xs text-subtle">
            {recording
              ? "松开结束"
              : transcribing
                ? "正在存录音"
                : last
                  ? "先选重听、重录、下一条或跳过"
                  : current
                    ? "按住录，松开停"
                    : "没有待录的类别"}
          </p>
        </div>
      </div>
    </div>
  );
}

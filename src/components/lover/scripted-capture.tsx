import { useCallback, useEffect, useState } from "react";
import { MicButton } from "@/components/lover/mic-button";
import { Button } from "@/components/ui/button";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { runHearingOnClip } from "@/lib/lover/hear";
import { type ScriptedCategoryId } from "@/lib/lover/hearing/config";
import {
  bumpScriptedCount,
  clipSaveBanner,
  countsFromQuotaRows,
  nextScriptedCategory,
} from "@/lib/lover/hearing/scripted";
import { setHearingSession } from "@/lib/lover/hearing/session";
import { scriptedQuota, undoHearingClip } from "@/lib/lover/hearing/store";
import { isQuotaHint, QUOTA_HINT } from "@/lib/lover/xai-error";

type LastTake = {
  clipId: string;
  category: ScriptedCategoryId;
  label: string;
  have: number;
  quota: number;
  xaiText: string;
};

type Props = {
  skipped: readonly string[];
  onSkip: (id: ScriptedCategoryId) => void;
  prompt?: string;
};

export function ScriptedCapturePanel({ skipped, onSkip, prompt }: Props) {
  const voice = useVoiceInput({ lang: "zh-CN", prompt });
  const [have, setHave] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<LastTake | null>(null);
  const current = nextScriptedCategory(have, skipped);

  const refreshQuota = useCallback(async () => {
    const result = await scriptedQuota();
    const counts = countsFromQuotaRows(result.categories);
    setHave(counts);
    const next = nextScriptedCategory(counts, skipped);
    setHearingSession({
      category: next?.id ?? null,
      scripted: true,
      source: "scripted",
      capture: true,
      mode: "scripted",
    });
    return counts;
  }, [skipped]);

  useEffect(() => {
    void refreshQuota();
  }, [refreshQuota]);

  useEffect(() => {
    const next = nextScriptedCategory(have, skipped);
    setHearingSession({
      category: next?.id ?? null,
      scripted: true,
      source: "scripted",
      capture: true,
      mode: "scripted",
    });
  }, [have, skipped]);

  const recording = voice.status === "recording";
  const transcribing = voice.status === "transcribing" || busy;

  const holdStart = useCallback(async () => {
    if (busy || transcribing || !current) return;
    setError(null);
    setLast(null);
    await voice.start();
  }, [busy, current, transcribing, voice]);

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
      const result = await runHearingOnClip({
        clip,
        liveText: collected?.liveText ?? "",
        prompt,
        speech_start: Date.now() - 1500,
        endpoint_fired: Date.now(),
        capture: true,
        source: "scripted",
        category: category.id,
      });
      if (result.saveError) {
        setError(clipSaveBanner(result.saveError));
        return;
      }
      if (!result.clipId) {
        setError("录音没存上：没有返回 clipId。");
        return;
      }
      const bumped = bumpScriptedCount(have, category.id);
      setHave(bumped);
      const fresh = await refreshQuota();
      const haveNow = fresh[category.id] ?? bumped[category.id] ?? 0;
      setLast({
        clipId: result.clipId,
        category: category.id,
        label: category.label,
        have: haveNow,
        quota: category.quota,
        xaiText: result.xaiText || result.tagged || "",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(isQuotaHint(message) ? QUOTA_HINT : clipSaveBanner(message));
    } finally {
      setBusy(false);
    }
  }, [current, have, prompt, refreshQuota, voice]);

  async function redo() {
    if (!last) return;
    const id = last.clipId;
    const category = last.category;
    setBusy(true);
    try {
      await undoHearingClip({ data: { id } });
      setLast(null);
      const fresh = await refreshQuota();
      setHave(fresh);
      setHearingSession({ category, scripted: true, source: "scripted", mode: "scripted" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function nextTake() {
    setLast(null);
    setError(null);
  }

  function skipCurrent() {
    const id = last?.category ?? current?.id;
    if (!id) return;
    onSkip(id);
    setLast(null);
    setError(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2">
      <div className="mx-auto flex w-full max-w-md min-h-0 flex-1 flex-col">
        <p className="text-xs text-subtle">定向录制 · 按住说话，松开就存。不发给清然。</p>
        {current ? (
          <div className="mt-3 rounded-md bg-surface-2 px-4 py-4">
            <p className="font-display text-2xl leading-tight">
              {current.label}
              <span className="ml-2 font-sans text-sm text-subtle">
                {have[current.id] ?? 0}/{current.quota}
              </span>
            </p>
            <p className="mt-2 text-sm text-muted">{current.hint}</p>
            <p className="mt-2 text-sm text-fg">示例：{current.example}</p>
          </div>
        ) : (
          <div className="mt-3 rounded-md bg-surface-2 px-4 py-4 text-sm text-muted">
            定向录制做完了。设置里可以恢复跳过的类别。
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
            <p className="mt-1 text-xs text-subtle">xAI 识别（仅供参考）</p>
            <p className="text-sm">{last.xaiText || "（空）"}</p>
            <div className="mt-3 flex flex-col gap-2">
              <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void redo()}>
                重录
              </Button>
              <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={nextTake}>
                下一条
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={busy || !(last || current)}
                onClick={skipCurrent}
              >
                跳过这个类别
              </Button>
            </div>
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
              ? voice.interim.trim() || "松开结束"
              : transcribing
                ? "正在存录音"
                : last
                  ? "先选重录、下一条或跳过"
                  : current
                    ? "按住录，松开停"
                    : "没有待录的类别"}
          </p>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  listVoiceChoices,
  SAMPLE_LINE,
  voiceSample,
  type VoiceChoice,
} from "@/lib/lover/voice-samples";
import { cn } from "@/lib/utils";

/** 试听声线: every xAI voice reads the same line; the recording is kept, so a new character can be given a voice by ear. */
export function VoicePanel() {
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<VoiceChoice[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** Voices being recorded right now. */
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [recordingAll, setRecordingAll] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  /** Only the last voice tapped may start playing. */
  const lastTap = useRef(0);
  const mounted = useRef(true);
  /** One recording per voice at a time, however many taps. */
  const inflight = useRef(new Map<string, Promise<string | null>>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      audio.current?.pause();
    };
  }, []);

  useEffect(() => {
    if (!open || voices || loadFailed) return;
    void listVoiceChoices()
      .then(setVoices)
      .catch((err) => {
        setLoadFailed(true);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [open, voices, loadFailed]);

  function mark(id: string, on: boolean) {
    setLoading((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function sample(id: string): Promise<string | null> {
    const running = inflight.current.get(id);
    if (running) return running;
    mark(id, true);
    const job = voiceSample({ data: { id } })
      .then((got) => {
        if (!got.ok) {
          setError(`${id}：${got.error}`);
          return null;
        }
        setVoices((cur) => cur?.map((v) => (v.id === id ? { ...v, recorded: true } : v)) ?? cur);
        return got.wav;
      })
      .catch((err) => {
        setError(`${id}：${err instanceof Error ? err.message : String(err)}`);
        return null;
      })
      .finally(() => {
        inflight.current.delete(id);
        mark(id, false);
      });
    inflight.current.set(id, job);
    return job;
  }

  function stop() {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  }

  async function play(id: string) {
    stop();
    setError(null);
    const tap = ++lastTap.current;
    const wav = await sample(id);
    if (!wav || tap !== lastTap.current || !mounted.current) return;
    const el = new Audio(`data:audio/wav;base64,${wav}`);
    audio.current = el;
    el.onended = () => {
      if (audio.current === el) setPlaying(null);
    };
    try {
      await el.play();
      if (audio.current === el) setPlaying(id);
    } catch (err) {
      if (audio.current === el) audio.current = null;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function recordAll() {
    if (recordingAll) return;
    setRecordingAll(true);
    setError(null);
    for (const v of voices ?? []) {
      if (!mounted.current) break;
      if (!v.recorded) await sample(v.id);
    }
    if (mounted.current) setRecordingAll(false);
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        试听声线
      </Button>
    );
  }

  const missing = voices?.filter((v) => !v.recorded).length ?? 0;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm">试听声线</p>
        {missing ? (
          <Button type="button" variant="outline" disabled={recordingAll} onClick={() => void recordAll()}>
            {recordingAll ? "在录…" : `把剩下 ${missing} 个都录好`}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-subtle">
        每个声线念同一句：「{SAMPLE_LINE}」。录过一次就存着，再听不花钱。喜欢哪个，把它的名字写进上面的角色声线。
      </p>
      {error ? <p className="text-xs text-live">{error}</p> : null}
      {!voices && !loadFailed ? <p className="text-xs text-subtle">在问 xAI 有哪些声线…</p> : null}
      {loadFailed ? (
        <Button type="button" variant="outline" onClick={() => setLoadFailed(false)}>
          再试一次
        </Button>
      ) : null}
      <ul className="flex flex-col">
        {voices?.map((v) => {
          const busy = loading.has(v.id);
          const on = playing === v.id;
          return (
            <li key={v.id} className="flex min-h-11 items-center gap-3 border-b border-border last:border-0">
              <button
                type="button"
                aria-label={on ? `停 ${v.id}` : `听 ${v.id}`}
                onClick={() => (on ? stop() : void play(v.id))}
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-full text-sm",
                  on ? "bg-accent text-accent-fg" : "bg-surface text-muted",
                )}
              >
                {busy ? "…" : on ? "■" : "▶"}
              </button>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm">{v.id}</p>
                {v.note || (v.name && v.name !== v.id) ? (
                  <p className="text-xs text-subtle">{v.note || v.name}</p>
                ) : null}
              </div>
              {v.recorded ? <span className="text-xs text-subtle">已录</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

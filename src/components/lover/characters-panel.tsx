import { Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { listVoiceChoices, voiceSample, type VoiceChoice } from "@/lib/lover/voice-samples";
import type { Character } from "@/lib/lover/types";

/** xAI's voices, asked the first time settings opens. */
export function useVoiceChoices(open: boolean): VoiceChoice[] | null {
  const [voices, setVoices] = useState<VoiceChoice[] | null>(null);
  useEffect(() => {
    if (!open || voices) return;
    let live = true;
    void listVoiceChoices()
      .then((list) => {
        if (live) setVoices(list);
      })
      .catch(() => {
        if (live) setVoices([]);
      });
    return () => {
      live = false;
    };
  }, [open, voices]);
  return voices;
}

/** One sample playing at a time across every picker on the page. */
let current: { el: HTMLAudioElement; stop: () => void } | null = null;

/**
 * A voice picked from xAI's list, with ▶ right beside it: pick, listen, keep or pick again. The sample (the same line
 * in every voice) is recorded once and kept. In a call nothing plays (the mic would hear it as her).
 */
export function VoiceSelect({
  value,
  voices,
  onChange,
  label,
  inCall = false,
}: {
  value: string;
  voices: VoiceChoice[] | null;
  onChange: (voice: string) => void;
  label: string;
  inCall?: boolean;
}) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState<string | null>(null);
  const tap = useRef(0);
  // Leaving the page stops whatever is playing.
  useEffect(
    () => () => {
      tap.current++;
      current?.el.pause();
      current = null;
    },
    [],
  );
  function stopSelf() {
    tap.current++;
    setState("idle");
  }
  async function play(id: string) {
    if (current) {
      current.el.pause();
      current.stop();
      current = null;
    }
    if (inCall) return;
    setError(null);
    const mine = ++tap.current;
    setState("loading");
    try {
      const got = await voiceSample({ data: { id } });
      if (mine !== tap.current) return;
      if (!got.ok) {
        setError(got.error);
        setState("idle");
        return;
      }
      const el = new Audio(`data:audio/wav;base64,${got.wav}`);
      current = { el, stop: stopSelf };
      el.onended = () => {
        if (current?.el === el) current = null;
        setState("idle");
      };
      await el.play();
      setState("playing");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("idle");
    }
  }

  const known = voices ?? [];
  const options = known.some((v) => v.id === value) ? known : [{ id: value, name: value, note: "", recorded: false }, ...known];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-11 items-center justify-between gap-2">
        <span className="text-sm">{label}</span>
        <div className="flex min-w-0 items-center gap-1">
          <select
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              void play(e.target.value);
            }}
            className="min-h-11 min-w-0 max-w-[13rem] rounded-md bg-surface-2 px-2 text-sm"
            aria-label={label}
          >
            {options.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
                {v.note ? ` · ${v.note}` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label={state === "playing" ? "停" : `试听 ${value}`}
            disabled={inCall}
            onClick={() => {
              if (state === "playing" && current) {
                current.el.pause();
                current = null;
                setState("idle");
              } else void play(value);
            }}
            className="grid size-11 shrink-0 place-items-center rounded-md text-muted disabled:opacity-30"
          >
            {state === "playing" ? <Square className="size-4" /> : <Play className={state === "loading" ? "size-4 animate-pulse" : "size-4"} />}
          </button>
        </div>
      </div>
      {error ? <p className="text-xs text-live">{error}</p> : null}
    </div>
  );
}

/**
 * Everyone besides 清然 she wrote: a name, a voice and who he is. Each persona goes into every reply after 清然's;
 * his 「名字：」 blocks are read in his voice. Saved as a whole list on each change.
 */
export function CharactersPanel({
  characters,
  othersVoice,
  voices,
  onSave,
  inCall = false,
}: {
  characters: Character[];
  othersVoice: string;
  voices: VoiceChoice[] | null;
  onSave: (patch: { characters?: Character[]; othersVoice?: string }) => void;
  inCall?: boolean;
}) {
  const [list, setList] = useState<Character[]>(characters);
  // What the server has, when it really changed (a reload hands over a new array with the same people). A card she
  // has not named yet is not saved, so it stays here below the saved ones instead of vanishing with the reload.
  const savedKey = JSON.stringify(characters);
  useEffect(() => {
    setList((cur) => [...characters, ...cur.filter((c) => !c.name.trim())]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const save = (next: Character[]) => {
    setList(next);
    onSave({ characters: next.filter((c) => c.name.trim()) });
  };
  const edit = (i: number, patch: Partial<Character>) => setList((cur) => cur.map((c, k) => (k === i ? { ...c, ...patch } : c)));

  return (
    <div className="flex flex-col gap-4">
      {list.map((c, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-3">
          <Input
            value={c.name}
            onChange={(e) => edit(i, { name: e.target.value })}
            onBlur={() => save(list)}
            placeholder="名字（比如 林泽）"
            aria-label="角色名字"
            maxLength={12}
          />
          <VoiceSelect label="声线" inCall={inCall} value={c.voice} voices={voices} onChange={(voice) => save(list.map((x, k) => (k === i ? { ...x, voice } : x)))} />
          <Textarea
            value={c.persona}
            onChange={(e) => edit(i, { persona: e.target.value })}
            onBlur={() => save(list)}
            maxLength={4000}
            className="min-h-32 resize-none leading-relaxed"
            placeholder="他是谁、和清然和你是什么关系、怎么说话、想要什么"
          />
          <button
            type="button"
            className="self-end text-xs text-subtle"
            onClick={() => save(list.filter((_, k) => k !== i))}
          >
            删掉这个角色
          </button>
        </div>
      ))}
      <Button type="button" variant="outline" onClick={() => setList((cur) => [...cur, { name: "", voice: othersVoice, persona: "" }])}>
        加一个角色
      </Button>
      <div className="flex flex-col gap-1">
        <VoiceSelect label="其他人的声线" inCall={inCall} value={othersVoice} voices={voices} onChange={(voice) => onSave({ othersVoice: voice })} />
        <p className="text-xs text-subtle">没写在这里、临时出场的人（服务员、路人）用这个声音。</p>
      </div>
    </div>
  );
}

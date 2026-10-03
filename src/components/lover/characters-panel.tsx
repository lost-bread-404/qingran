import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { listVoiceChoices, type VoiceChoice } from "@/lib/lover/voice-samples";
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

/** A voice picked from the list (试听 in 声音和听力 → 试听声线). Keeps a voice the list no longer has. */
export function VoiceSelect({
  value,
  voices,
  onChange,
  label,
}: {
  value: string;
  voices: VoiceChoice[] | null;
  onChange: (voice: string) => void;
  label: string;
}) {
  const known = voices ?? [];
  const options = known.some((v) => v.id === value) ? known : [{ id: value, name: value, note: "", recorded: false }, ...known];
  return (
    <label className="flex min-h-11 items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 max-w-[60%] rounded-md bg-surface-2 px-2 text-sm"
        aria-label={label}
      >
        {options.map((v) => (
          <option key={v.id} value={v.id}>
            {v.id}
            {v.note ? ` · ${v.note}` : ""}
          </option>
        ))}
      </select>
    </label>
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
}: {
  characters: Character[];
  othersVoice: string;
  voices: VoiceChoice[] | null;
  onSave: (patch: { characters?: Character[]; othersVoice?: string }) => void;
}) {
  const [list, setList] = useState<Character[]>(characters);
  useEffect(() => setList(characters), [characters]);

  const save = (next: Character[]) => {
    setList(next);
    // A card still without a name is kept here (and dropped when the profile is read back), so nothing typed is lost.
    onSave({ characters: next });
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
          <VoiceSelect label="声线" value={c.voice} voices={voices} onChange={(voice) => save(list.map((x, k) => (k === i ? { ...x, voice } : x)))} />
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
        <VoiceSelect label="其他人的声线" value={othersVoice} voices={voices} onChange={(voice) => onSave({ othersVoice: voice })} />
        <p className="text-xs text-subtle">没写在这里、临时出场的人（服务员、路人）用这个声音。</p>
      </div>
    </div>
  );
}

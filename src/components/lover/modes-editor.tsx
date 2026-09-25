import { useEffect, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import type { TalkModeDef, VoiceEffort } from "@/lib/lover/types";

export type ModelRow = {
  id: string;
  blurb: string;
  supportsEffort: boolean;
  stats: { n: number; avgMs: number | null } | null;
};

function sec(ms: number | null | undefined): string {
  return ms == null || !Number.isFinite(ms) ? "—" : `${(ms / 1000).toFixed(1)} 秒`;
}

/** One reply model for every mode, with how long each model has taken on replies so far. */
function ModelPicker({
  models,
  current,
  onPick,
}: {
  models: ModelRow[] | null;
  current: string;
  onPick: (id: string, effort: VoiceEffort) => void;
}) {
  if (models == null) return <p className="text-sm text-subtle">正在读模型…</p>;
  const list = models.some((m) => m.id === current)
    ? models
    : [{ id: current, blurb: "", supportsEffort: false, stats: null }, ...models];
  return (
    <div className="flex flex-col gap-1">
      {list.map((m) => (
        <label key={m.id} className="flex min-h-11 items-start gap-3 rounded-md bg-surface px-3 py-2">
          <input
            type="radio"
            name="reply-model"
            className="mt-1"
            checked={m.id === current}
            onChange={() => onPick(m.id, m.supportsEffort ? "low" : null)}
          />
          <span className="flex flex-col">
            <span className="text-sm">{m.id}</span>
            <span className="text-xs text-subtle">
              {m.stats && m.stats.n > 0 ? `回复过 ${m.stats.n} 次，平均 ${sec(m.stats.avgMs)}` : "还没用来回复过"}
              {m.blurb ? ` · ${m.blurb}` : ""}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

function newId(existing: TalkModeDef[]): string {
  let n = existing.length + 1;
  while (existing.some((m) => m.id === `mode${n}`)) n += 1;
  return `mode${n}`;
}

export function ModesEditor({
  modes,
  models,
  model,
  onModes,
  onModel,
}: {
  modes: TalkModeDef[];
  models: ModelRow[] | null;
  model: string;
  onModes: (next: TalkModeDef[]) => void;
  onModel: (id: string, effort: VoiceEffort) => void;
}) {
  const [draft, setDraft] = useState<TalkModeDef[]>(modes);
  useEffect(() => setDraft(modes), [modes]);
  const commit = (next: TalkModeDef[]) => {
    setDraft(next);
    onModes(next);
  };
  const patch = (i: number, part: Partial<TalkModeDef>) => setDraft((cur) => cur.map((m, j) => (j === i ? { ...m, ...part } : m)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-sm">回复模型</p>
        <p className="text-xs text-subtle">所有模式都用这一个模型。</p>
        <ModelPicker models={models} current={model} onPick={onModel} />
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm">模式</p>
        <p className="text-xs text-subtle">
          开着「运行心思和记忆整理」时，他的心思会看每个模式写的「什么时候用」，决定你下一次来时用哪个；关掉时，在聊天页右上角手动切。模式的 prompt 会接在人设后面发给他。
        </p>
        {draft.map((m, i) => (
          <div key={m.id} className="flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-3">
            <input
              className="h-11 rounded-md bg-surface px-3 text-sm"
              value={m.name}
              placeholder="名字"
              onChange={(e) => patch(i, { name: e.target.value })}
              onBlur={() => commit(draft)}
            />
            <label className="flex flex-col gap-1">
              <span className="text-xs text-subtle">什么时候用、什么时候结束</span>
              <Textarea
                value={m.when}
                onChange={(e) => patch(i, { when: e.target.value })}
                onBlur={() => commit(draft)}
                className="min-h-20 resize-none leading-relaxed"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-subtle">这个模式的 prompt（空着就只用人设）</span>
              <Textarea
                value={m.prompt}
                onChange={(e) => patch(i, { prompt: e.target.value })}
                onBlur={() => commit(draft)}
                className="min-h-32 resize-none font-mono leading-relaxed"
              />
            </label>
            {draft.length > 1 ? (
              <button type="button" className="h-11 self-start text-sm text-muted" onClick={() => commit(draft.filter((_, j) => j !== i))}>
                删掉这个模式
              </button>
            ) : null}
          </div>
        ))}
        {draft.length < 8 ? (
          <button
            type="button"
            className="h-11 self-start text-sm text-muted"
            onClick={() => commit([...draft, { id: newId(draft), name: "新模式", when: "", prompt: "" }])}
          >
            加一个模式
          </button>
        ) : null}
      </div>
    </div>
  );
}

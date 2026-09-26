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
          开着「运行心思和记忆整理」时，他的心思每轮之后看每个模式写的「什么时候用」，决定下一句用哪个；关掉时，在聊天页右上角手动切。模式的 prompt 接在人设后面，作为「现在大致是什么时候」的基调发给他：眼前真的发生的事和他心里的感觉比它优先。所以写这个时候你们大概是什么样就够了，不用把每种情况都列出来。
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
            <label className="flex items-center justify-between gap-3">
              <span className="text-xs text-subtle">temperature（空着 = 1.0；越高越放得开、越不重复，0–2）</span>
              <input
                className="h-11 w-20 rounded-md bg-surface px-3 text-sm"
                inputMode="decimal"
                value={m.temperature == null ? "" : String(m.temperature)}
                placeholder="1.0"
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const n = Number(raw);
                  patch(i, { temperature: raw === "" || !Number.isFinite(n) ? null : Math.max(0, Math.min(2, n)) });
                }}
                onBlur={() => commit(draft)}
              />
            </label>
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={m.intimate}
                onChange={(e) => commit(draft.map((row, j) => (j === i ? { ...row, intimate: e.target.checked } : row)))}
              />
              <span className="text-xs text-subtle">这个模式里给他看亲密设定</span>
            </label>
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={!m.keepActions}
                onChange={(e) => commit(draft.map((row, j) => (j === i ? { ...row, keepActions: !e.target.checked } : row)))}
              />
              <span className="text-xs text-subtle">夜里整理记忆时，这个模式里只记说的话，不记他的动作</span>
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
            onClick={() =>
              commit([
                ...draft,
                { id: newId(draft), name: "新模式", when: "", prompt: "", temperature: null, keepActions: true, intimate: false },
              ])
            }
          >
            加一个模式
          </button>
        ) : null}
      </div>
    </div>
  );
}

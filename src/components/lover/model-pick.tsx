import type { VoiceEffort } from "@/lib/lover/types";

export type ModelOption = { id: string; blurb: string; efforts: Array<string | null> };
export type ModelStat = { model: string; n: number; avgMs: number | null };

const EFFORT_LABEL: Record<string, string> = { none: "不想", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };

/** Efforts she can pick for a model (none for a model without them). */
export function effortsOf(models: ModelOption[], model: string): VoiceEffort[] {
  const found = models.find((m) => m.id === model);
  const list = found ? found.efforts : model.startsWith("claude-") ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"];
  return list.filter((e): e is Exclude<VoiceEffort, null> => e === "low" || e === "medium" || e === "high" || e === "xhigh" || e === "max");
}

/**
 * One model (Claude or Grok) and how hard it thinks, with how long it has taken so far.
 * Used for the day reply (设置 → 回复) and the night pass (设置 → 记忆).
 */
export function ModelPick({
  label,
  models,
  stats,
  model,
  effort,
  timeWord,
  onChange,
}: {
  label: string;
  models: ModelOption[] | null;
  stats: ModelStat[];
  model: string;
  effort: VoiceEffort;
  /** What the time is: 「每句」 or 「每次整理」. */
  timeWord: string;
  onChange: (model: string, effort: VoiceEffort) => void;
}) {
  const list = models ?? [];
  const options = list.some((m) => m.id === model) ? list : [{ id: model, blurb: "", efforts: [] }, ...list];
  const byModel = new Map(stats.map((s) => [s.model, s]));
  const time = (id: string) => {
    const s = byModel.get(id);
    return s?.avgMs != null ? ` · ${timeWord}平均 ${(s.avgMs / 1000).toFixed(1)} 秒（${s.n} 次）` : " · 还没用过";
  };
  const efforts = effortsOf(list, model);
  const pick = (next: string) => {
    const allowed = effortsOf(list, next);
    onChange(next, allowed.includes(effort) ? effort : (allowed.includes("low") ? "low" : (allowed[0] ?? null)));
  };
  const group = (claude: boolean) => options.filter((m) => m.id.startsWith("claude-") === claude);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{label}</p>
      <select value={model} aria-label={label} onChange={(e) => pick(e.target.value)} className="min-h-11 rounded-md bg-surface px-2 text-sm">
        {[
          ["Claude", group(true)],
          ["Grok", group(false)],
        ].map(([name, rows]) =>
          (rows as ModelOption[]).length ? (
            <optgroup key={name as string} label={name as string}>
              {(rows as ModelOption[]).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {time(m.id)}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
      </select>
      {options.find((m) => m.id === model)?.blurb ? <p className="text-xs text-subtle">{options.find((m) => m.id === model)!.blurb}</p> : null}
      {efforts.length ? (
        <div className="flex gap-2">
          {efforts.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onChange(model, id)}
              className={`min-h-11 flex-1 rounded-md px-1 text-sm ${effort === id ? "bg-fg text-bg" : "bg-surface"}`}
            >
              {EFFORT_LABEL[id ?? "none"]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

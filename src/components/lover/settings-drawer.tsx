import { Check, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { keepCaretVisible, useVisualViewportHeight } from "@/hooks/use-visual-viewport";
import { HEARING_PROVIDERS, labEngineLabel, type HearingProviderId } from "@/lib/lover/hearing/config";
import { PROVIDER_ENV } from "@/lib/lover/hearing/env";
import { hearingConnectionTest, hearingEnvStatus } from "@/lib/lover/hearing/store";
import { slowEngineHint } from "@/lib/lover/hearing/select";
import { formatHearingTimingSummary, parseHearingTimingLine } from "@/lib/lover/hearing/timing-format";
import { formatCallAudioLogLines, subscribeCallAudioLog } from "@/lib/lover/call-audio-log";
import {
  brainGetCallLog,
  brainGetLongLayer,
  brainListNotes,
  brainListPrompts,
  brainResetMind,
  brainRestorePrompt,
  brainSaveLongLayer,
  brainSaveNote,
  brainSavePrompt,
  brainGetDbSize,
  brainListVoiceModels,
} from "@/lib/lover/brain/api";
import type { BrainLogRow, Mind, Note, PortraitRow, Subject } from "@/lib/lover/brain/types";
import { parseVoiceInputCharsLine } from "@/lib/lover/brain/voice/pack-build";
import { fromDatetimeLocal, toDatetimeLocal } from "@/lib/lover/memory";
import { BrainBackupPanel } from "@/components/lover/brain-backup-panel";
import { LogoutButton } from "@/components/lover/logout-button";
import { DEFAULT_SYSTEM_PROMPT, VOICE_EFFORT_OPTIONS, isVoiceEffort, type Profile, type VoiceEffort } from "@/lib/lover/types";
import { SILENCE_MS_OPTIONS, type SilenceMs } from "@/lib/lover/vad";
import { cn } from "@/lib/utils";

type Tab = "prompt" | "prompts" | "notes" | "portrait" | "mind" | "log" | "hearing";

type PromptItem = {
  key: string;
  name: string;
  blurb: string;
  placeholders: Array<{ token: string; meaning: string }>;
  defaultText: string;
  body: string;
  hash: string;
  custom: boolean;
  updatedAt: number | null;
};

type CallDetail = {
  messages: Array<{ role: string; content: string }>;
  warnings: string[];
  output: string;
};

type VoiceModelStat = {
  model: string;
  n: number;
  avgMs: number | null;
  avgTtftMs: number | null;
  emptyRate: number | null;
};

type VoiceModelOption = {
  id: string;
  blurb: string;
  supportsEffort: boolean;
  stats: VoiceModelStat | null;
};

function formatVoiceMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${Math.round(ms)}ms`;
}

function formatEmptyRate(rate: number | null): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  const pct = rate * 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

function formatVoiceStats(stats: VoiceModelStat | null): string {
  if (!stats || stats.n <= 0) return "未使用";
  return `近7天 平均 ${formatVoiceMs(stats.avgMs)} · 首字 ${formatVoiceMs(stats.avgTtftMs)} · 空回复 ${formatEmptyRate(stats.emptyRate)} · ${stats.n} 次`;
}

function effortForModel(model: VoiceModelOption, current: VoiceEffort): VoiceEffort {
  if (!model.supportsEffort) return null;
  return isVoiceEffort(current) ? current : "low";
}

function withSelectedVoiceModel(
  models: VoiceModelOption[],
  stats: VoiceModelStat[],
  selected: string,
): VoiceModelOption[] {
  const byStats = new Map(stats.map((row) => [row.model, row]));
  const list = models.some((model) => model.id === selected)
    ? models
    : [
        {
          id: selected,
          blurb: "暂无说明",
          supportsEffort: !/non-reasoning/i.test(selected),
          stats: null,
        },
        ...models,
      ];
  return list.map((model) => ({ ...model, stats: model.stats ?? byStats.get(model.id) ?? null }));
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile;
  onSave: (next: Profile) => void;
  onClearChat: () => void;
};

export function SettingsDrawer({ open, onOpenChange, profile, onSave, onClearChat }: Props) {
  const [draft, setDraft] = useState(profile.systemPrompt);
  const [hearingProvider, setHearingProvider] = useState<HearingProviderId>(profile.hearingProvider);
  const [debugHearing, setDebugHearing] = useState(profile.debugHearing);
  const [providerReady, setProviderReady] = useState<Record<HearingProviderId, boolean> | null>(null);
  const [labPassword, setLabPassword] = useState("");
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeRows, setProbeRows] = useState<Array<{ id: string; ok: boolean; latency_ms: number; error?: string }> | null>(null);
  const [tab, setTab] = useState<Tab>("prompt");
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const [subject, setSubject] = useState<Subject | "">("");
  const [newFact, setNewFact] = useState("");
  const [newAt, setNewAt] = useState(() => toDatetimeLocal(Date.now()));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [self, setSelf] = useState("");
  const [bond, setBond] = useState("");
  const [portrait, setPortrait] = useState<PortraitRow[]>([]);
  const [mind, setMind] = useState<Mind | null>(null);
  const [log, setLog] = useState<BrainLogRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [newTopic, setNewTopic] = useState("");
  const [newBody, setNewBody] = useState("");
  const [dbWarn, setDbWarn] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [voiceModel, setVoiceModel] = useState(profile.voiceModel);
  const [voiceEffort, setVoiceEffort] = useState<VoiceEffort>(profile.voiceEffort);
  const [voiceModels, setVoiceModels] = useState<VoiceModelOption[] | null>(null);
  const [voiceStats, setVoiceStats] = useState<VoiceModelStat[]>([]);
  const [silenceMs, setSilenceMs] = useState<SilenceMs>(profile.silenceMs);
  const [promptItems, setPromptItems] = useState<PromptItem[]>([]);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [promptBusy, setPromptBusy] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [callById, setCallById] = useState<Record<number, CallDetail | "loading">>({});
  const viewport = useVisualViewportHeight(open);

  useEffect(() => {
    if (!open) return;
    setDraft(profile.systemPrompt);
    setHearingProvider(profile.hearingProvider);
    setDebugHearing(profile.debugHearing);
    setVoiceModel(profile.voiceModel);
    setVoiceEffort(profile.voiceEffort);
    setSilenceMs(profile.silenceMs);
    setLabPassword(typeof sessionStorage !== "undefined" ? sessionStorage.getItem("qingran-hearing-lab") ?? "" : "");
    setTab("prompt");
    setPromptItems([]);
    setPromptDrafts({});
    setPromptError(null);
    setCallById({});
    void hearingEnvStatus().then((result) => setProviderReady(result.providers)).catch(() => undefined);
    setEditingId(null);
    setNewAt(toDatetimeLocal(Date.now()));
    setClearArmed(false);
    void refresh();
    void brainListVoiceModels()
      .then((res) => {
        setVoiceModels(res.models);
        setVoiceStats(res.stats ?? []);
      })
      .catch(() => {
        setVoiceModels([]);
        setVoiceStats([]);
      });
  }, [open, profile.systemPrompt]);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
      keepCaretVisible(active);
    }
  }, [open, viewport.height, viewport.offsetTop]);

  useEffect(() => {
    if (!open || tab !== "prompts") return;
    let cancelled = false;
    void brainListPrompts()
      .then((items) => {
        if (cancelled) return;
        setPromptItems(items as PromptItem[]);
        setPromptDrafts((prev) => {
          const next = { ...prev };
          for (const it of items as PromptItem[]) {
            if (next[it.key] == null) next[it.key] = it.body;
          }
          return next;
        });
      })
      .catch(() => {
        if (!cancelled) setPromptError("指令列表没读出来。");
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab]);

  async function refresh() {
    const [noteRes, layer] = await Promise.all([
      brainListNotes({ data: { q: query || undefined, subject: subject || undefined } }),
      brainGetLongLayer(),
    ]);
    setNotes(noteRes);
    setSelf(layer.self);
    setBond(layer.bond);
    setPortrait(layer.portrait);
    setMind(layer.mind);
    setLog(layer.log);
    void brainGetDbSize()
      .then((s) => setDbWarn(Boolean(s.warn)))
      .catch(() => setDbWarn(false));
  }

  function persistProfile(patch: Partial<Profile>) {
    onSave({
      ...profile,
      systemPrompt: draft.trim() || DEFAULT_SYSTEM_PROMPT,
      hearingProvider,
      captureAudio: debugHearing,
      debugHearing,
      voiceModel,
      voiceEffort,
      silenceMs,
      ...patch,
    });
  }

  function persistVoice(nextModel: string, nextEffort: VoiceEffort) {
    setVoiceModel(nextModel);
    setVoiceEffort(nextEffort);
    persistProfile({ voiceModel: nextModel, voiceEffort: nextEffort });
  }

  function savePrompt() {
    const ready = providerReady?.[hearingProvider];
    const fallback = HEARING_PROVIDERS.find((id) => providerReady?.[id]) ?? "xai";
    const nextProvider = ready === false ? fallback : hearingProvider;
    persistProfile({ hearingProvider: nextProvider });
    onOpenChange(false);
  }

  async function savePromptItem(key: string) {
    const body = promptDrafts[key] ?? "";
    setPromptBusy(key);
    setPromptError(null);
    try {
      const saved = (await brainSavePrompt({ data: { key, body } })) as PromptItem;
      setPromptItems((rows) => rows.map((row) => (row.key === key ? { ...row, ...saved, name: row.name, blurb: row.blurb, placeholders: row.placeholders, defaultText: row.defaultText } : row)));
      setPromptDrafts((d) => ({ ...d, [key]: saved.body }));
    } catch {
      setPromptError("没记下。");
    } finally {
      setPromptBusy(null);
    }
  }

  async function restorePromptItem(key: string) {
    setPromptBusy(key);
    setPromptError(null);
    try {
      const restored = (await brainRestorePrompt({ data: { key } })) as PromptItem;
      setPromptItems((rows) =>
        rows.map((row) =>
          row.key === key
            ? { ...row, ...restored, name: row.name, blurb: row.blurb, placeholders: row.placeholders, defaultText: row.defaultText }
            : row,
        ),
      );
      setPromptDrafts((d) => ({ ...d, [key]: restored.body }));
    } catch {
      setPromptError("没恢复成默认。");
    } finally {
      setPromptBusy(null);
    }
  }

  function loadCall(row: BrainLogRow) {
    if (callById[row.id] && callById[row.id] !== "loading") return;
    setCallById((m) => (m[row.id] ? m : { ...m, [row.id]: "loading" }));
    void brainGetCallLog({ data: { id: row.id } })
      .then((rec) => {
        const obj = rec && typeof rec === "object" ? (rec as Record<string, unknown>) : null;
        const rebuilt = obj?.rebuilt && typeof obj.rebuilt === "object" ? (obj.rebuilt as { messages?: Array<{ role: string; content: string }>; warnings?: string[] }) : null;
        const assembled = Array.isArray(obj?.assembled)
          ? (obj.assembled as Array<{ role: string; content: string }>)
          : rebuilt?.messages;
        const output =
          (typeof obj?.output === "string" && obj.output) ||
          (typeof obj?.output_text === "string" && obj.output_text) ||
          (typeof obj?.raw === "string" && obj.raw) ||
          "";
        setCallById((m) => ({
          ...m,
          [row.id]: {
            messages: assembled ?? [],
            warnings: rebuilt?.warnings ?? [],
            output,
          },
        }));
      })
      .catch(() => {
        setCallById((m) => ({
          ...m,
          [row.id]: { messages: [], warnings: ["读不出这次发给模型的全文"], output: "" },
        }));
      });
  }

  async function saveLong() {
    setBusy(true);
    try {
      await brainSaveLongLayer({
        data: {
          self,
          bond,
          portrait: portrait.map((p) => ({ id: p.id, topic: p.topic, body: p.body })),
        },
      });
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    const text = newFact.replace(/\s+/g, " ").trim();
    if (!text) return;
    setBusy(true);
    try {
      await brainSaveNote({
        data: {
          text,
          happenedAt: fromDatetimeLocal(newAt),
          subject: "us",
          lens: ["bond", "diary"],
        },
      });
      setNewFact("");
      setNewAt(toDatetimeLocal(Date.now()));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveNoteEdit(id: string) {
    const text = editDraft.replace(/\s+/g, " ").trim();
    if (!text) return;
    setBusy(true);
    try {
      await brainSaveNote({ data: { id, text } });
      setEditingId(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function archiveNote(id: string) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    setBusy(true);
    try {
      await brainSaveNote({ data: { id, text: note.text, archive: true } });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function addPortraitRow() {
    const topic = newTopic.trim();
    const body = newBody.trim();
    if (!topic || !body) return;
    setPortrait((rows) => [
      ...rows,
      {
        id: `p:${Date.now()}`,
        topic,
        body,
        status: "active",
        evidenceIds: [],
        lastSeen: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    setNewTopic("");
    setNewBody("");
  }

  if (!open) return null;

  const tabs: Array<[Tab, string]> = [
    ["prompt", "人设"],
    ["prompts", "指令"],
    ["notes", "笔记"],
    ["portrait", "画像"],
    ["mind", "内心"],
    ["hearing", "听力"],
    ["log", "记录"],
  ];

  return (
    <div
      className="fixed inset-x-0 z-50 flex flex-col bg-bg"
      style={{ top: viewport.offsetTop, height: viewport.height }}
    >
      <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          aria-label="关闭"
          onClick={() => onOpenChange(false)}
          className="grid size-11 place-items-center rounded-md text-muted"
        >
          <X className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-medium tracking-tight">清然</p>
          <p className="text-xs text-subtle">人设、笔记、她眼里的你们。</p>
        </div>
        {tab === "prompt" || tab === "hearing" ? (
          <Button type="button" size="pill" onClick={savePrompt}>
            保存
          </Button>
        ) : tab === "portrait" ? (
          <Button type="button" size="pill" disabled={busy} onClick={() => void saveLong()}>
            保存
          </Button>
        ) : null}
      </header>

      <div className="flex shrink-0 gap-1 overflow-x-auto px-4 pb-3">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "shrink-0 rounded-md px-3 py-2 text-sm",
              tab === id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "prompt" ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              keepCaretVisible(e.currentTarget);
            }}
            onSelect={(e) => keepCaretVisible(e.currentTarget)}
            onFocus={(e) => {
              const box = e.currentTarget;
              window.setTimeout(() => {
                window.scrollTo(0, 0);
                keepCaretVisible(box);
              }, 50);
            }}
            maxLength={8000}
            className="min-h-0 flex-1 resize-none font-mono leading-relaxed"
            placeholder="写给模型的 system prompt"
          />
          <p className="mt-2 text-xs text-subtle">笔记会另外附上，不用写进这段。其他步骤的指令在「指令」页。</p>
        </div>
      ) : tab === "prompts" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-3">
            <p className="text-xs text-subtle">
              每个步骤发给模型的指令。人设只用「人设」那一份，这里用 {"{system_prompt}"} 引用。记下之后下一轮立刻生效。
            </p>
            {promptError ? <p className="text-sm text-live">{promptError}</p> : null}
            {promptItems.length === 0 ? (
              <p className="text-sm text-subtle">正在读指令…</p>
            ) : (
              promptItems.map((item) => {
                const draftBody = promptDrafts[item.key] ?? item.body;
                const dirty = draftBody !== item.body;
                const canRestore = item.custom || item.updatedAt != null;
                return (
                  <details key={item.key} className="rounded-md bg-surface-2 px-3 py-2">
                    <summary className="cursor-pointer">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-fg">{item.name}</span>
                        {item.custom ? <span className="text-[11px] text-live">已改</span> : null}
                      </div>
                      <p className="mt-1 text-xs text-subtle">{item.blurb}</p>
                    </summary>
                    {item.placeholders.length ? (
                      <ul className="mt-2 flex flex-col gap-1 text-[11px] text-subtle">
                        {item.placeholders.map((p) => (
                          <li key={p.token}>
                            <span className="text-fg">{`{${p.token}}`}</span>
                            {" · "}
                            {p.meaning}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-[11px] text-subtle">这一步没有占位符。</p>
                    )}
                    <Textarea
                      value={draftBody}
                      onChange={(e) => {
                        const value = e.target.value;
                        setPromptDrafts((d) => ({ ...d, [item.key]: value }));
                        keepCaretVisible(e.currentTarget);
                      }}
                      onSelect={(e) => keepCaretVisible(e.currentTarget)}
                      className="mt-2 min-h-40 resize-y font-mono text-xs leading-relaxed"
                    />
                    <div className="mt-2 flex gap-2">
                      <Button
                        type="button"
                        size="pill"
                        disabled={promptBusy === item.key || !dirty}
                        onClick={() => void savePromptItem(item.key)}
                      >
                        {promptBusy === item.key ? "记下…" : "记下"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={promptBusy === item.key || !canRestore}
                        onClick={() => void restorePromptItem(item.key)}
                      >
                        恢复默认
                      </Button>
                    </div>
                  </details>
                );
              })
            )}
          </div>
        </div>
      ) : tab === "notes" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <BrainBackupPanel />
            {dbWarn ? (
              <p className="text-sm text-live">数据库已用超过 70%，请到日记「系统档案」查看容量。</p>
            ) : null}
            <a href="/diary#spend" className="text-sm text-subtle underline-offset-2 hover:underline">
              费用
            </a>
            <LogoutButton />
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜笔记"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void refresh();
                }}
              />
              <select
                value={subject}
                onChange={(e) => setSubject(e.target.value as Subject | "")}
                className="h-11 rounded-md bg-surface-2 px-2 text-sm text-fg"
              >
                <option value="">全部</option>
                <option value="rosie">Rosie</option>
                <option value="qingran">清然</option>
                <option value="us">我们</option>
              </select>
              <Button type="button" variant="outline" onClick={() => void refresh()}>
                筛
              </Button>
            </div>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void addNote();
              }}
            >
              <Textarea
                value={newFact}
                onChange={(e) => {
                  setNewFact(e.target.value);
                  keepCaretVisible(e.currentTarget);
                }}
                onSelect={(e) => keepCaretVisible(e.currentTarget)}
                onFocus={(e) => {
                  const box = e.currentTarget;
                  window.setTimeout(() => keepCaretVisible(box), 50);
                }}
                placeholder="记下大事"
                maxLength={120}
                className="min-h-24 resize-none"
              />
              <div className="flex gap-2">
                <Input type="datetime-local" value={newAt} onChange={(e) => setNewAt(e.target.value)} />
                <Button type="submit" size="pill" disabled={!newFact.trim() || busy}>
                  记下
                </Button>
              </div>
            </form>
            {notes.length === 0 ? (
              <p className="text-sm text-subtle">还没有笔记。通话里会慢慢记下来。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {notes.map((n) => (
                  <li key={n.id} className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
                    {editingId === n.id ? (
                      <Input
                        autoFocus
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        className="flex-1"
                      />
                    ) : (
                      <span className="flex-1 leading-relaxed">
                        <span className="mr-2 text-xs text-subtle">{n.localDay.slice(5)}</span>
                        {n.text}
                        {n.tags.length ? (
                          <span className="mt-1 block text-xs text-subtle">{n.tags.join(" · ")}</span>
                        ) : null}
                      </span>
                    )}
                    {editingId === n.id ? (
                      <button
                        type="button"
                        aria-label="好"
                        onClick={() => void saveNoteEdit(n.id)}
                        className="mt-0.5 text-subtle hover:text-fg"
                      >
                        <Check className="size-4" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label="改"
                        onClick={() => {
                          setEditingId(n.id);
                          setEditDraft(n.text);
                        }}
                        className="mt-0.5 text-subtle hover:text-fg"
                      >
                        <Pencil className="size-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="归档"
                      onClick={() => void archiveNote(n.id)}
                      className="mt-0.5 text-subtle hover:text-fg"
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!clearArmed ? (
              <Button variant="outline" onClick={() => setClearArmed(true)}>
                只清屏幕
              </Button>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-subtle">
                  让她忘掉最近还没记住的对话？已经记住的事和故事线不受影响。
                </p>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      onClearChat();
                      setClearArmed(false);
                    }}
                  >
                    确定清空
                  </Button>
                  <Button variant="outline" onClick={() => setClearArmed(false)}>
                    取消
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : tab === "portrait" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-5">
            <label className="flex flex-col gap-2">
              <span className="text-xs text-subtle">我自己</span>
              <Textarea value={self} onChange={(e) => setSelf(e.target.value)} maxLength={300} className="min-h-28" />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-xs text-subtle">我们</span>
              <Textarea value={bond} onChange={(e) => setBond(e.target.value)} maxLength={200} className="min-h-24" />
            </label>
            <div className="flex flex-col gap-2">
              <span className="text-xs text-subtle">我眼中的她</span>
              {portrait.map((p) => (
                <div key={p.id} className="rounded-md bg-surface-2 p-3">
                  <Input
                    value={p.topic}
                    onChange={(e) =>
                      setPortrait((rows) =>
                        rows.map((r) => (r.id === p.id ? { ...r, topic: e.target.value } : r)),
                      )
                    }
                    className="mb-2"
                  />
                  <Textarea
                    value={p.body}
                    onChange={(e) =>
                      setPortrait((rows) =>
                        rows.map((r) => (r.id === p.id ? { ...r, body: e.target.value } : r)),
                      )
                    }
                    maxLength={80}
                    className="min-h-16"
                  />
                </div>
              ))}
              <div className="flex flex-col gap-2">
                <Input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} placeholder="主题，如 被安慰的方式" />
                <Textarea
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  placeholder="她是怎样的"
                  maxLength={80}
                  className="min-h-16"
                />
                <Button type="button" variant="outline" onClick={addPortraitRow}>
                  加上一条
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : tab === "mind" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            {mind ? (
              <dl className="flex flex-col gap-3 text-sm">
                <MindRow label="她现在" value={mind.rosie_now} />
                <MindRow label="底下的东西" value={mind.undercurrent} />
                <MindRow label="感受" value={mind.my_feel} />
                <MindRow label="看法" value={mind.my_view} />
                <MindRow label="思路" value={mind.my_logic} />
                <MindRow label="要带她走的路" value={mind.lead_plan.join(" → ")} />
                <MindRow label="这一句" value={mind.intent} />
                <MindRow label="要跟进" value={mind.threads.join("；")} />
              </dl>
            ) : (
              <p className="text-sm text-subtle">还没有内心。说几句之后会慢慢有。</p>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void brainResetMind()
                  .then(() => refresh())
                  .finally(() => setBusy(false));
              }}
            >
              重置内心
            </Button>
          </div>
        </div>
      ) : tab === "hearing" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-5">
            <label className="flex items-start gap-3 rounded-md bg-surface-2 px-3 py-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={debugHearing}
                onChange={(e) => setDebugHearing(e.target.checked)}
              />
              <span>
                <span className="block text-sm">标注模式</span>
                <span className="block text-xs text-subtle">
                  打开后每一句都存成 clip，并启用确认面板。关掉就不存录音，铅笔只是改字。
                </span>
              </span>
            </label>
            <Link
              to="/lab"
              className="flex min-h-11 items-center justify-center rounded-md bg-surface-2 px-3 text-sm"
              onClick={() => onOpenChange(false)}
            >
              打开标注页
            </Link>
            <details className="rounded-md bg-surface-2 px-3 py-3">
              <summary className="cursor-pointer text-sm">高级</summary>
              <div className="mt-3 flex flex-col gap-4">
                <div>
                  <p className="mb-2 text-sm">回复模型</p>
                  <p className="mb-2 text-xs text-subtle">
                    实时对话用。切换后下一句立刻生效。报错或空回复会自动用 grok-4.20-0309-non-reasoning 再试一次。
                  </p>
                  {voiceModels == null ? (
                    <p className="mb-2 text-xs text-subtle">正在拉取模型列表…</p>
                  ) : null}
                  <div className="flex flex-col gap-2">
                    {withSelectedVoiceModel(voiceModels ?? [], voiceStats, voiceModel).map((opt) => {
                      const selected = voiceModel === opt.id;
                      return (
                        <div
                          key={opt.id}
                          className={cn(
                            "rounded-md px-3 py-3",
                            selected ? "bg-accent text-accent-fg" : "bg-bg text-muted",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => persistVoice(opt.id, effortForModel(opt, voiceEffort))}
                            className="min-h-11 w-full text-left text-sm"
                          >
                            <span className="block font-medium">{opt.id}</span>
                            <span className={cn("mt-1 block text-xs", selected ? "opacity-90" : "text-subtle")}>
                              {opt.blurb}
                            </span>
                            <span className={cn("mt-1 block text-[11px]", selected ? "opacity-80" : "text-subtle")}>
                              {formatVoiceStats(opt.stats)}
                            </span>
                          </button>
                          {opt.supportsEffort ? (
                            <div className="mt-2 grid grid-cols-3 gap-1">
                              {VOICE_EFFORT_OPTIONS.map((effort) => (
                                <button
                                  key={effort}
                                  type="button"
                                  onClick={() => persistVoice(opt.id, effort)}
                                  className={cn(
                                    "min-h-11 rounded-md px-2 text-xs",
                                    selected && voiceEffort === effort
                                      ? "bg-bg text-fg"
                                      : selected
                                        ? "bg-black/10"
                                        : "bg-surface-2",
                                  )}
                                >
                                  {effort}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-sm">听力引擎</p>
                  <p className="mb-2 text-xs text-subtle">实时默认 xAI + Apple。其它引擎会拒答亲密内容，只留在这里备查。</p>
                  {slowEngineHint(hearingProvider) ? (
                    <p className="mb-2 text-xs text-live">{slowEngineHint(hearingProvider)}</p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    {HEARING_PROVIDERS.map((id) => {
                      const ready = providerReady ? providerReady[id] : true;
                      const missing = PROVIDER_ENV[id];
                      return (
                        <button
                          key={id}
                          type="button"
                          disabled={!ready}
                          onClick={() => ready && setHearingProvider(id)}
                          className={cn(
                            "min-h-11 rounded-md px-3 py-3 text-left text-sm disabled:opacity-50",
                            hearingProvider === id ? "bg-accent text-accent-fg" : "bg-bg text-muted",
                          )}
                        >
                          <span className="block">{({ xai: "xAI", qwen: "Qwen", gemini: "Gemini", selfhost: "自部署" } as Record<string, string>)[id]}</span>
                          <span className="mt-1 block text-[11px] opacity-80">
                            {providerReady == null ? "正在检查…" : ready ? "已配置" : `缺少 ${missing}`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-sm">静音判定</p>
                  <p className="mb-2 text-xs text-subtle">说完后等多久才开始识别。默认 1.5 秒。</p>
                  <div className="grid grid-cols-3 gap-2">
                    {SILENCE_MS_OPTIONS.map((ms) => (
                      <button
                        key={ms}
                        type="button"
                        onClick={() => {
                          setSilenceMs(ms);
                          persistProfile({ silenceMs: ms });
                        }}
                        className={cn(
                          "min-h-11 rounded-md px-3 py-3 text-sm",
                          silenceMs === ms ? "bg-accent text-accent-fg" : "bg-bg text-muted",
                        )}
                      >
                        {(ms / 1000).toFixed(1)} 秒
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-sm">引擎自检</p>
                  <p className="mt-1 text-xs text-subtle">用 lab 密码。对各引擎发 1 秒测试音频，看能不能通。</p>
                  <Input
                    type="password"
                    value={labPassword}
                    onChange={(e) => setLabPassword(e.target.value)}
                    placeholder="lab 密码"
                    className="mt-3"
                    autoComplete="off"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2 min-h-11 w-full"
                    disabled={probeBusy || !labPassword.trim()}
                    onClick={() => {
                      const secret = labPassword.trim();
                      if (!secret) return;
                      setProbeBusy(true);
                      setProbeError(null);
                      void hearingConnectionTest({ data: { password: secret } })
                        .then((result) => {
                          sessionStorage.setItem("qingran-hearing-lab", secret);
                          setProbeRows(result.engines as Array<{ id: string; ok: boolean; latency_ms: number; error?: string }>);
                        })
                        .catch((err) => {
                          setProbeRows(null);
                          const message = err instanceof Error ? err.message : String(err);
                          setProbeError(message === "lab-locked" ? "密码不对。" : message);
                        })
                        .finally(() => setProbeBusy(false));
                    }}
                  >
                    {probeBusy ? "正在自检…" : "引擎自检"}
                  </Button>
                  {probeError ? <p className="mt-2 text-xs text-subtle">{probeError}</p> : null}
                  {probeRows ? (
                    <ul className="mt-3 flex flex-col gap-2">
                      {probeRows.map((row) => (
                        <li key={row.id} className="text-xs leading-relaxed">
                          <span className="text-sm text-fg">
                            {labEngineLabel(row.id)} {row.ok ? "成功" : "失败"} · {row.latency_ms}ms
                          </span>
                          {!row.ok && row.error ? (
                            <span className="mt-1 block break-all text-subtle">{row.error}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </details>
            {debugHearing ? <AudioTracePanel /> : null}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-2">
            {slowEngineHint(hearingProvider) ? (
              <p className="text-xs text-live">{slowEngineHint(hearingProvider)}</p>
            ) : null}
            {log.filter((row) => row.route === "hear" || row.step === "hearing").length ? (
              <div className="mb-2 rounded-md bg-surface-2 px-3 py-2">
                <p className="text-xs text-subtle">最近听力耗时</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {log
                    .filter((row) => row.route === "hear" || row.step === "hearing")
                    .slice(0, 20)
                    .map((row) => {
                      const timing = parseHearingTimingLine(row.note);
                      return (
                        <li key={row.id} className="text-[11px] leading-relaxed text-fg">
                          <span className="text-subtle">{logClock(row.at)} </span>
                          {timing ? formatHearingTimingSummary(timing) : row.note || `${row.ms ?? "—"}ms`}
                        </li>
                      );
                    })}
                </ul>
              </div>
            ) : null}
            {log.length === 0 ? (
              <p className="text-sm text-subtle">还没有调用记录。</p>
            ) : (
              log.map((row) => {
                const failLine = row.ok ? "" : logFailFirstLine(row);
                const timing = parseHearingTimingLine(row.note);
                const engineHint = slowEngineHintFromNote(row.note);
                return (
                  <details
                    key={row.id}
                    className="rounded-md bg-surface-2 px-3 py-2 text-xs"
                    onToggle={(e) => {
                      if (e.currentTarget.open) loadCall(row);
                    }}
                  >
                    <summary className="cursor-pointer">
                      <div className="flex items-center justify-between gap-2">
                        <span className={row.ok ? "text-fg" : "text-live"}>{row.step}</span>
                        <span className="text-subtle">{row.ms != null ? `${row.ms}ms` : ""}</span>
                      </div>
                      {engineHint ? <p className="mt-1 text-live">{engineHint}</p> : null}
                      {timing ? (
                        <p className="mt-1 text-subtle">{formatHearingTimingSummary(timing)}</p>
                      ) : null}
                      {failLine ? <p className="mt-1 text-live">{failLine}</p> : null}
                    </summary>
                    <dl className="mt-2 flex flex-col gap-1.5 text-subtle">
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide">prompt</dt>
                        <dd className="mt-0.5 break-all">
                          {row.promptKey || "—"}
                          {row.promptHash ? ` · ${row.promptHash.slice(0, 12)}` : ""}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide">发给模型</dt>
                        <dd className="mt-0.5 whitespace-pre-wrap break-all">
                          {callById[row.id] === "loading"
                            ? "正在拼回这一次的全文…"
                            : callById[row.id] && callById[row.id] !== "loading"
                              ? (callById[row.id] as CallDetail).messages.length
                                ? (callById[row.id] as CallDetail).messages
                                    .map((m, i) => `【${m.role} ${i + 1}】\n${m.content}`)
                                    .join("\n\n")
                                : "这一次没有存下完整 prompt。"
                              : "点开后会去拼。"}
                        </dd>
                      </div>
                      {callById[row.id] && callById[row.id] !== "loading" && (callById[row.id] as CallDetail).warnings.length ? (
                        <div>
                          <dt className="text-[10px] uppercase tracking-wide">warnings</dt>
                          <dd className="mt-0.5 whitespace-pre-wrap break-all text-live">
                            {(callById[row.id] as CallDetail).warnings.join("\n")}
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide">返回</dt>
                        <dd className="mt-0.5 whitespace-pre-wrap break-all">
                          {callById[row.id] && callById[row.id] !== "loading"
                            ? (callById[row.id] as CallDetail).output || row.outputText || (row.raw ?? "").slice(0, 1000) || "—"
                            : (row.outputText || (row.raw ?? "").slice(0, 1000) || "—")}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide">note</dt>
                        <dd className="mt-0.5 whitespace-pre-wrap break-all">{row.note || "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide">raw</dt>
                        <dd className="mt-0.5 whitespace-pre-wrap break-all">
                          {(row.raw ?? "").slice(0, 1000) || "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide">finish_reason</dt>
                        <dd className="mt-0.5 break-all">{logFinishReason(row) || "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide">input_chars</dt>
                        <dd className="mt-0.5 whitespace-pre-wrap break-all">{logInputChars(row)}</dd>
                      </div>
                    </dl>
                  </details>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function logFailFirstLine(row: BrainLogRow): string {
  const src = (row.note || row.error || "").trim();
  if (!src) return "";
  return src.split(/\r?\n/, 1)[0] ?? "";
}

function slowEngineHintFromNote(note: string | null | undefined): string {
  const line = (note ?? "").split(/\r?\n/).find((part) => part.includes("会拖慢识别"));
  return line?.trim() || "";
}

function logClock(at: number): string {
  try {
    return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function logInputChars(row: BrainLogRow): string {
  const split = parseVoiceInputCharsLine(row.note);
  const parts = split
    ? `system ${split.system} · mind ${split.mind} · 记忆笔记 ${split.notes} · 对话历史 ${split.history} · 用户消息 ${split.user}`
    : "";
  if (parts && row.inputChars != null) return `${row.inputChars}（${parts}）`;
  if (parts) return parts;
  return row.inputChars != null ? String(row.inputChars) : "—";
}

function logFinishReason(row: BrainLogRow): string {
  const blob = `${row.note ?? ""}\n${row.error ?? ""}`;
  const tagged = blob.match(/finish_reason[=:]([^\s]+)/i);
  if (tagged?.[1]) return tagged[1];
  const raw = row.raw?.trim();
  if (raw && (raw.startsWith("{") || raw.startsWith("["))) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const choice = Array.isArray(j.choices) ? (j.choices[0] as Record<string, unknown> | undefined) : undefined;
      const inc =
        j.incomplete_details && typeof j.incomplete_details === "object"
          ? (j.incomplete_details as { reason?: unknown }).reason
          : undefined;
      const v =
        (typeof j.finish_reason === "string" && j.finish_reason) ||
        (typeof j.finishReason === "string" && j.finishReason) ||
        (typeof choice?.finish_reason === "string" && choice.finish_reason) ||
        (typeof inc === "string" && inc) ||
        (typeof j.status === "string" && j.status) ||
        "";
      return v;
    } catch {
      return "";
    }
  }
  return "";
}

function MindRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-1 leading-relaxed">{value}</dd>
    </div>
  );
}

function AudioTracePanel() {
  const [lines, setLines] = useState(() => formatCallAudioLogLines());
  useEffect(() => {
    setLines(formatCallAudioLogLines());
    return subscribeCallAudioLog(() => setLines(formatCallAudioLogLines()));
  }, []);
  return (
    <div>
      <p className="mb-2 text-sm">音频日志</p>
      <pre className="max-h-52 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-muted">
        {lines || "还没有。切一次后台再回来，看这里。"}
      </pre>
    </div>
  );
}

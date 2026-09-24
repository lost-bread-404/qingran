import { Check, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { keepCaretVisible, useVisualViewportHeight } from "@/hooks/use-visual-viewport";
import { HEARING, STT_KEYTERMS, DEFAULT_XAI_VAD_THRESHOLD, lockSttKeyterms } from "@/lib/lover/hearing/config";
import { formatHearingTimingSummary, parseHearingTimingLine } from "@/lib/lover/hearing/timing-format";
import { formatCallAudioLogLines, subscribeCallAudioLog } from "@/lib/lover/call-audio-log";
import {
  brainGetCallLog,
  brainGetDbSize,
  brainGetLongLayer,
  brainListHygieneNotes,
  brainDeleteHygieneNotes,
  brainListLogs,
  brainListNotes,
  brainListPrompts,
  brainListVoiceModels,
  brainResetMind,
  brainRestorePrompt,
  brainRollbackPrompt,
  brainSaveLongLayer,
  brainSaveNote,
  brainSavePrompt,
  brainSetPortraitStatus,
  brainDeletePortrait,
  brainSaveSeedPortrait,
  brainSyncHistoryWindow,
} from "@/lib/lover/brain/api";
import type { BrainLogRow, InnerState, Note, PortraitRow, Subject } from "@/lib/lover/brain/types";
import { parseVoiceInputCharsLine } from "@/lib/lover/brain/voice/pack-build";
import {
  formatCallLogPlain,
  formatDbBytes,
  labelCallMessages,
  LOG_RANGE_FILTERS,
  LOG_ROUTE_FILTERS,
  logRangeMs,
  splitMindHighlight,
  type CallLogMessage,
  type LogRangeId,
} from "@/lib/lover/call-log-view";
import { fromDatetimeLocal, toDatetimeLocal } from "@/lib/lover/memory";
import { PromptStepEditor, type PromptEditorItem, type PromptModelChoice } from "@/components/lover/prompt-step-editor";
import { HearingSensePanel } from "@/components/lover/hearing-sense-panel";
import { BrainBackupPanel } from "@/components/lover/brain-backup-panel";
import { LogoutButton } from "@/components/lover/logout-button";
import { DEFAULT_SYSTEM_PROMPT, clampHistoryWindow, clampPortraitActiveMax, clampPortraitStaleDays, clampRetrieveMinTerms, formatVoiceInjectLine, parseVoiceInjectLine, voiceInjectFromProfile, type HearingSense, type Profile, type VoiceEffort } from "@/lib/lover/types";
import { defaultPromptModel } from "@/lib/lover/brain/prompts/models";
import { parseSenseLine } from "@/lib/lover/hearing/sense";
import { cn } from "@/lib/utils";

type Tab = "prompt" | "prompts" | "notes" | "portrait" | "mind" | "log" | "hearing";

type PromptItem = PromptEditorItem;

type CallDetail = {
  messages: CallLogMessage[];
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

function toModelChoices(models: VoiceModelOption[]): PromptModelChoice[] {
  return models.map((model) => ({
    id: model.id,
    blurb: model.blurb,
    supportsEffort: model.supportsEffort,
    stats: model.stats
      ? {
          n: model.stats.n,
          avgMs: model.stats.avgMs,
          avgTtftMs: model.stats.avgTtftMs,
          emptyRate: model.stats.emptyRate,
        }
      : null,
  }));
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

function fmtPortraitTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile;
  callPhase?: string | null;
  callDeaf?: boolean;
  onSave: (next: Profile) => void;
  onClearChat: () => void;
};

export function SettingsDrawer({ open, onOpenChange, profile, callPhase = null, callDeaf = false, onSave, onClearChat }: Props) {
  const [draft, setDraft] = useState(profile.systemPrompt);
  const [debugHearing, setDebugHearing] = useState(profile.debugHearing);
  const [labPassword, setLabPassword] = useState("");
  const [tab, setTab] = useState<Tab>("prompt");
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
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
  const [portraitView, setPortraitView] = useState<"active" | "stale" | "superseded">("active");
  const [portraitActiveMax, setPortraitActiveMax] = useState(String(profile.portraitActiveMax));
  const [portraitStaleDays, setPortraitStaleDays] = useState(String(profile.portraitStaleDays));
  const [seedDrafts, setSeedDrafts] = useState<Record<string, { topic: string; body: string }>>({});
  const [retrieveMinTerms, setRetrieveMinTerms] = useState(String(profile.retrieveMinTerms));
  const [inner, setInner] = useState<InnerState | null>(null);
  const [log, setLog] = useState<BrainLogRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [dbWarn, setDbWarn] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [voiceModel, setVoiceModel] = useState(profile.voiceModel);
  const [voiceEffort, setVoiceEffort] = useState<VoiceEffort>(profile.voiceEffort);
  const [voiceModels, setVoiceModels] = useState<VoiceModelOption[] | null>(null);
  const [voiceStats, setVoiceStats] = useState<VoiceModelStat[]>([]);
  const [promptModels, setPromptModels] = useState(profile.promptModels);
  const [hearingInstruction, setHearingInstruction] = useState(profile.hearingInstruction);
  const [sense, setSense] = useState<HearingSense>(profile.hearingSense);
  const [injectMind, setInjectMind] = useState(profile.injectMind);
  const [injectMemories, setInjectMemories] = useState(profile.injectMemories);
  const [injectLongterm, setInjectLongterm] = useState(profile.injectLongterm);
  const [historyWindow, setHistoryWindow] = useState(profile.historyWindow);
  const [callKitBackground, setCallKitBackground] = useState(profile.callKitBackground);
  const [keytermDraft, setKeytermDraft] = useState(profile.sttKeyterms.join("\n"));
  const historySyncRef = useRef(0);
  const [hygieneNotes, setHygieneNotes] = useState<Array<{ id: string; text: string; subject: string; localDay: string }>>([]);
  const [promptItems, setPromptItems] = useState<PromptItem[]>([]);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [promptBusy, setPromptBusy] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [callById, setCallById] = useState<Record<number, CallDetail | "loading">>({});
  const [logRoute, setLogRoute] = useState<string | null>(null);
  const [logRange, setLogRange] = useState<LogRangeId>("7d");
  const [logCopied, setLogCopied] = useState<number | null>(null);
  const [dbSize, setDbSize] = useState<{ totalBytes: number | null; limitMb: number; warn: boolean } | null>(null);
  const viewport = useVisualViewportHeight(open);

  useEffect(() => {
    if (!open) return;
    setDraft(profile.systemPrompt);
    setDebugHearing(profile.debugHearing);
    setVoiceModel(profile.voiceModel);
    setVoiceEffort(profile.voiceEffort);
    setPromptModels(profile.promptModels);
    setHearingInstruction(profile.hearingInstruction);
    setSense(profile.hearingSense);
    setInjectMind(profile.injectMind);
    setInjectMemories(profile.injectMemories);
    setInjectLongterm(profile.injectLongterm);
    setHistoryWindow(profile.historyWindow);
    setCallKitBackground(profile.callKitBackground);
    setPortraitActiveMax(String(profile.portraitActiveMax));
    setPortraitStaleDays(String(profile.portraitStaleDays));
    setRetrieveMinTerms(String(profile.retrieveMinTerms));
    setPortraitView("active");
    setKeytermDraft(profile.sttKeyterms.join("\n"));
    setLabPassword(typeof sessionStorage !== "undefined" ? sessionStorage.getItem("qingran-hearing-lab") ?? "" : "");
    setTab("prompt");
    setPromptItems([]);
    setPromptDrafts({});
    setPromptError(null);
    setCallById({});
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

  useEffect(() => {
    if (!open || tab !== "log") return;
    let cancelled = false;
    const to = Date.now();
    const from = to - logRangeMs(logRange);
    void brainListLogs({ data: { route: logRoute, from, to, limit: 200 } })
      .then((rows) => {
        if (!cancelled) setLog(rows as BrainLogRow[]);
      })
      .catch(() => {
        if (!cancelled) setLog([]);
      });
    void brainGetDbSize()
      .then((s) => {
        if (cancelled) return;
        setDbSize({ totalBytes: s.totalBytes ?? null, limitMb: s.limitMb, warn: Boolean(s.warn) });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, tab, logRoute, logRange]);

  async function refresh() {
    const [noteRes, layer] = await Promise.all([
      brainListNotes({ data: { q: query || undefined, subject: subject || undefined } }),
      brainGetLongLayer(),
    ]);
    setNotes(noteRes);
    setSelf(layer.self);
    setBond(layer.bond);
    setPortrait(layer.portrait);
    setSeedDrafts(
      Object.fromEntries(
        layer.portrait
          .filter((row) => row.kind === "seed")
          .map((row) => [row.id, { topic: row.topic, body: row.body }]),
      ),
    );
    setInner(layer.inner ?? layer.mind);
    setLog(layer.log);
    void brainListHygieneNotes()
      .then((rows) => setHygieneNotes(rows as Array<{ id: string; text: string; subject: string; localDay: string }>))
      .catch(() => setHygieneNotes([]));
    void brainGetDbSize()
      .then((s) => {
        setDbWarn(Boolean(s.warn));
        setDbSize({ totalBytes: s.totalBytes ?? null, limitMb: s.limitMb, warn: Boolean(s.warn) });
      })
      .catch(() => setDbWarn(false));
  }

  function persistProfile(patch: Partial<Profile>) {
    onSave({
      ...profile,
      systemPrompt: draft.trim() || DEFAULT_SYSTEM_PROMPT,
      hearingProvider: "xai",
      captureAudio: debugHearing,
      debugHearing,
      voiceModel,
      voiceEffort,
      promptModels,
      hearingInstruction,
      silenceMs: sense.endWaitMs,
      nightVoicedMin: sense.voicedMin,
      nightMinMs: sense.noiseMinMs,
      hearingSense: sense,
      injectMind,
      injectMemories,
      injectLongterm,
      historyWindow,
      callKitBackground,
      sttKeyterms: lockSttKeyterms(keytermDraft.split("\n")),
      portraitActiveMax: clampPortraitActiveMax(portraitActiveMax),
      portraitStaleDays: clampPortraitStaleDays(portraitStaleDays),
      retrieveMinTerms: clampRetrieveMinTerms(retrieveMinTerms),
      ...patch,
    });
  }

  function commitSense(next: HearingSense) {
    setSense(next);
    persistProfile({
      hearingSense: next,
      silenceMs: next.endWaitMs,
      nightVoicedMin: next.voicedMin,
      nightMinMs: next.noiseMinMs,
    });
  }

  function persistPromptModel(key: string, nextModel: string, nextEffort: VoiceEffort) {
    if (key === "voice") {
      setVoiceModel(nextModel);
      setVoiceEffort(nextEffort);
      persistProfile({ voiceModel: nextModel, voiceEffort: nextEffort });
      return;
    }
    const next = { ...promptModels, [key]: { model: nextModel, effort: nextEffort } };
    setPromptModels(next);
    persistProfile({ promptModels: next });
  }

  function savePrompt() {
    persistProfile({ hearingProvider: "xai" });
    onOpenChange(false);
  }

  function promptPick(key: string): { model: string; effort: VoiceEffort } {
    const uiEffort = (effort: string | null): VoiceEffort =>
      effort === "low" || effort === "medium" || effort === "high" ? effort : null;
    if (key === "voice") return { model: voiceModel, effort: voiceEffort };
    const saved = promptModels[key as keyof typeof promptModels];
    if (saved) return { model: saved.model, effort: uiEffort(saved.effort) };
    const fallback = defaultPromptModel(key);
    return { model: fallback.model, effort: uiEffort(fallback.effort) };
  }

  function commitHistoryWindow(nextRaw: number) {
    const next = clampHistoryWindow(nextRaw);
    setHistoryWindow(next);
    persistProfile({ historyWindow: next });
    window.clearTimeout(historySyncRef.current);
    historySyncRef.current = window.setTimeout(() => {
      void brainSyncHistoryWindow({ data: { historyWindow: next } }).catch(() => undefined);
    }, 400);
  }

  async function savePromptItem(key: string) {
    const body = promptDrafts[key] ?? "";
    setPromptBusy(key);
    setPromptError(null);
    try {
      const saved = (await brainSavePrompt({ data: { key, body } })) as unknown as PromptItem;
      setPromptItems((rows) => rows.map((row) => (row.key === key ? { ...row, ...saved, name: row.name, blurb: row.blurb, placeholders: row.placeholders } : row)));
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
      const restored = (await brainRestorePrompt({ data: { key } })) as unknown as PromptItem;
      setPromptItems((rows) =>
        rows.map((row) =>
          row.key === key
            ? { ...row, ...restored, name: row.name, blurb: row.blurb, placeholders: row.placeholders }
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

  async function rollbackPromptItem(key: string, hash: string) {
    setPromptBusy(key);
    setPromptError(null);
    try {
      const restored = (await brainRollbackPrompt({ data: { key, hash } })) as unknown as PromptItem;
      setPromptItems((rows) =>
        rows.map((row) =>
          row.key === key
            ? {
                ...row,
                ...restored,
                name: row.name,
                blurb: row.blurb,
                placeholders: row.placeholders,
                versions: (row.versions ?? []).filter((version) => version.hash !== restored.hash),
              }
            : row,
        ),
      );
      setPromptDrafts((d) => ({ ...d, [key]: restored.body }));
    } catch {
      setPromptError("没退回去。");
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
        const warnings = Array.isArray(obj?.warnings)
          ? (obj.warnings as string[])
          : rebuilt?.warnings ?? [];
        setCallById((m) => ({
          ...m,
          [row.id]: {
            messages: labelCallMessages(assembled ?? []),
            warnings,
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

  async function copyCall(row: BrainLogRow, detail: CallDetail) {
    const text = formatCallLogPlain({
      step: row.step,
      model: row.model,
      effort: row.effort,
      ms: row.ms,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      tokensCached: row.tokensCached,
      tokensReasoning: row.tokensReasoning,
      costUsd: row.costUsd,
      finishReason: logFinishReason(row),
      error: row.error,
      inputChars: row.inputChars,
      trimmed: row.trimmed,
      messages: detail.messages,
      output: detail.output || row.outputText || "",
    });
    try {
      await navigator.clipboard.writeText(text);
      setLogCopied(row.id);
      window.setTimeout(() => setLogCopied((cur) => (cur === row.id ? null : cur)), 1500);
    } catch {
      setLogCopied(null);
    }
  }

  async function saveLong() {
    setBusy(true);
    try {
      await brainSaveLongLayer({
        data: { self, bond },
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

  async function markPortraitStale(id: string) {
    setBusy(true);
    try {
      await brainSetPortraitStatus({ data: { id, status: "stale" } });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function removePortrait(id: string) {
    setBusy(true);
    try {
      await brainDeletePortrait({ data: { id } });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveSeed(id: string) {
    const draft = seedDrafts[id];
    if (!draft) return;
    setBusy(true);
    try {
      await brainSaveSeedPortrait({ data: { id, topic: draft.topic, body: draft.body } });
      await refresh();
    } finally {
      setBusy(false);
    }
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
              点开一步改消息。人设在「人设」页，这里用 {"{system_prompt}"} 引用。记下后下一轮生效。
            </p>
            <div className="flex flex-col gap-1 rounded-md bg-surface-2 px-3 py-2">
              <p className="px-1 pt-1 text-sm">这一轮带上什么</p>
            <p className="text-xs text-subtle">只影响开口那一句。</p>
              <label className="flex min-h-11 items-center gap-3 rounded-md px-1">
                <input
                  type="checkbox"
                  checked={injectLongterm}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setInjectLongterm(next);
                    persistProfile({ injectLongterm: next });
                  }}
                />
                <span className="text-sm">我记得的</span>
              </label>
              <div className="px-1 pb-2">
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <p className="text-sm">上下文长度</p>
                  <p className="text-sm tabular-nums">{historyWindow}</p>
                </div>
                <input
                  type="range"
                  min={0}
                  max={80}
                  step={1}
                  value={historyWindow}
                  aria-label="上下文长度"
                  onChange={(e) => commitHistoryWindow(Number(e.target.value))}
                  className="h-11 w-full accent-accent"
                />
                <p className="text-xs text-subtle">
                  {formatVoiceInjectLine(
                    voiceInjectFromProfile({ injectMind, injectLongterm, historyWindow }),
                  )}
                </p>
              </div>
            </div>
            {promptError ? <p className="text-sm text-live">{promptError}</p> : null}
            {promptItems.length === 0 ? (
              <p className="text-sm text-subtle">正在读指令…</p>
            ) : (
              promptItems.map((item) => {
                const pick = promptPick(item.key);
                return (
                <PromptStepEditor
                  key={item.key}
                  item={item}
                  draft={promptDrafts[item.key] ?? item.body}
                  busy={promptBusy === item.key}
                  open={openPrompt === item.key}
                  onOpenChange={(next) =>
                    setOpenPrompt((current) => (next ? item.key : current === item.key ? null : current))
                  }
                  onDraft={(body) => setPromptDrafts((d) => ({ ...d, [item.key]: body }))}
                  onSave={() => void savePromptItem(item.key)}
                  onRestore={() => void restorePromptItem(item.key)}
                  onRollback={(hash) => void rollbackPromptItem(item.key, hash)}
                  models={
                    voiceModels == null
                      ? null
                      : toModelChoices(withSelectedVoiceModel(voiceModels, voiceStats, pick.model))
                  }
                  model={pick.model}
                  effort={pick.effort}
                  onModel={(model, effort) => persistPromptModel(item.key, model, effort)}
                />
                );
              })
            )}
          </div>
        </div>
      ) : tab === "notes" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <BrainBackupPanel />
            {hygieneNotes.length ? (
              <div className="rounded-md bg-surface-2 px-3 py-3">
                <p className="text-sm">这些笔记像是在记清然自己的行为，不是 Rosie 透露的事。</p>
                <ul className="mt-2 flex flex-col gap-2">
                  {hygieneNotes.map((row) => (
                    <li key={row.id} className="text-sm leading-relaxed">
                      <span className="text-subtle">{row.localDay} · {row.subject}</span>
                      <span className="mt-0.5 block">{row.text}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 min-h-11"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void brainDeleteHygieneNotes({ data: { ids: hygieneNotes.map((row) => row.id) } })
                      .then(() => refresh())
                      .finally(() => setBusy(false));
                  }}
                >
                  确认删除这些笔记
                </Button>
              </div>
            ) : null}
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
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-2">
                <span className="text-xs text-subtle">使用中最多几条</span>
                <Input
                  type="number"
                  min={4}
                  max={40}
                  value={portraitActiveMax}
                  onChange={(e) => setPortraitActiveMax(e.target.value)}
                  onBlur={() => {
                    const n = clampPortraitActiveMax(portraitActiveMax);
                    setPortraitActiveMax(String(n));
                    persistProfile({ portraitActiveMax: n });
                  }}
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="text-xs text-subtle">几天没印证就过期</span>
                <Input
                  type="number"
                  min={3}
                  max={90}
                  value={portraitStaleDays}
                  onChange={(e) => setPortraitStaleDays(e.target.value)}
                  onBlur={() => {
                    const n = clampPortraitStaleDays(portraitStaleDays);
                    setPortraitStaleDays(String(n));
                    persistProfile({ portraitStaleDays: n });
                  }}
                />
              </label>
            </div>
            <p className="text-xs text-subtle">
              右上角保存只记下「我自己」和「我们」。过期和已推翻的不会写进回复。关系阶段和设定不占上面的条数，设定也不会过期。
            </p>
            <div className="flex flex-col gap-2">
              <span className="text-xs text-subtle">设定</span>
              <p className="text-xs text-subtle">
                从故事线来的人物、世界观和称呼。生成画像时会带上，但不会改它们。只有你能改。
              </p>
              {portrait.filter((row) => row.kind === "seed").length === 0 ? (
                <p className="text-sm text-subtle">还没有设定。</p>
              ) : (
                portrait
                  .filter((row) => row.kind === "seed")
                  .map((p) => {
                    const draft = seedDrafts[p.id] ?? { topic: p.topic, body: p.body };
                    return (
                      <div key={p.id} className="rounded-md bg-surface-2 p-3">
                        <Input
                          value={draft.topic}
                          maxLength={40}
                          onChange={(e) =>
                            setSeedDrafts((cur) => ({ ...cur, [p.id]: { ...draft, topic: e.target.value } }))
                          }
                        />
                        <Textarea
                          value={draft.body}
                          maxLength={2000}
                          onChange={(e) =>
                            setSeedDrafts((cur) => ({ ...cur, [p.id]: { ...draft, body: e.target.value } }))
                          }
                          className="mt-2 min-h-24"
                        />
                        <div className="mt-2 flex gap-2">
                          <Button type="button" variant="outline" disabled={busy} onClick={() => void saveSeed(p.id)}>
                            保存这条
                          </Button>
                          <Button type="button" variant="outline" disabled={busy} onClick={() => void removePortrait(p.id)}>
                            删除
                          </Button>
                        </div>
                      </div>
                    );
                  })
              )}
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs text-subtle">我眼中的她</span>
              <div className="flex gap-2">
                {(
                  [
                    ["active", "使用中"],
                    ["stale", "过期"],
                    ["superseded", "已推翻"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPortraitView(id)}
                    className={
                      portraitView === id
                        ? "rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg"
                        : "rounded-md bg-surface-2 px-3 py-1.5 text-sm text-muted"
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              {portrait.filter((row) => row.kind !== "seed" && row.status === portraitView).length === 0 ? (
                <p className="text-sm text-subtle">这一栏还没有。</p>
              ) : (
                portrait
                  .filter((row) => row.kind !== "seed" && row.status === portraitView)
                  .map((p) => (
                    <div key={p.id} className="rounded-md bg-surface-2 p-3">
                      <p className="text-sm font-medium">
                        {p.topic}
                        {p.topic === "关系阶段" ? " · 固定" : ""}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{p.body}</p>
                      <p className="mt-2 text-xs text-subtle">
                        {p.kind === "episode" ? "具体事件" : "稳定特点"}
                        {" · "}
                        依据 {p.evidenceCount ?? p.evidenceIds.length} 条
                        {p.evidenceFrom ? ` · ${p.evidenceFrom}` : ""}
                        {p.evidenceTo && p.evidenceTo !== p.evidenceFrom ? ` – ${p.evidenceTo}` : ""}
                      </p>
                      <p className="text-xs text-subtle">
                        印证 {p.supportCount} 次 · 最近 {fmtPortraitTime(p.lastSupportedAt)}
                      </p>
                      {p.retireReason ? (
                        <p className="mt-1 text-xs text-subtle">建议退出：{p.retireReason}</p>
                      ) : null}
                      <div className="mt-2 flex gap-2">
                        {p.status === "active" ? (
                          <Button
                            type="button"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void markPortraitStale(p.id)}
                          >
                            置为过期
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void removePortrait(p.id)}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
      ) : tab === "mind" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <label className="flex items-start gap-3 rounded-md bg-surface-2 px-3 py-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={injectMind}
                onChange={(e) => {
                  const next = e.target.checked;
                  setInjectMind(next);
                  persistProfile({ injectMind: next });
                }}
              />
              <span>
                <span className="block text-sm">注入我此刻</span>
                <span className="block text-xs text-subtle">关掉就不把心里、想要、惦记和正在做放进回复。取舍和计划本来就不会放进去。</span>
              </span>
            </label>
            {inner && (inner.feel || inner.want || inner.choice || inner.now || inner.longing || inner.plans.length) ? (
              <div className="whitespace-pre-wrap text-sm leading-relaxed">
                <p>心里：{inner.feel || "（空）"}</p>
                <p>想要：{inner.want || "（空）"}</p>
                <p>取舍：{inner.choice || "（空）"}</p>
                <p>正在做：{inner.now || "（空）"}</p>
                <p>惦记：{inner.longing || "（空）"}</p>
                {inner.plans.filter((plan) => plan.status === "open").length ? (
                  <div className="mt-2">
                    <p>还开着的计划：</p>
                    {inner.plans
                      .filter((plan) => plan.status === "open")
                      .map((plan) => (
                        <p key={plan.id}>
                          {plan.what}
                          {plan.trigger ? ` · ${plan.trigger}` : ""}
                        </p>
                      ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-subtle">还没有写下这一轮的心思。</p>
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
              清空这一轮的心思
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
                checked={callKitBackground}
                onChange={(e) => {
                  const next = e.target.checked;
                  setCallKitBackground(next);
                  persistProfile({ callKitBackground: next });
                }}
              />
              <span>
                <span className="block text-sm">切到后台也继续通话</span>
                <span className="block text-xs text-subtle">
                  开启后会显示系统通话界面，锁屏或切到其他 app 也不会断。
                </span>
              </span>
            </label>
            <HearingSensePanel
              sense={sense}
              labPassword={labPassword}
              onLabPassword={(next) => {
                setLabPassword(next);
                try {
                  sessionStorage.setItem("qingran-hearing-lab", next);
                } catch {
                  /* private mode */
                }
              }}
              onChange={commitSense}
            />
            <section className="flex flex-col gap-3">
              <div>
                <p className="text-sm">识别时发出去的内容</p>
                <p className="mt-1 text-xs text-subtle">xAI 和 Apple 只回你说的字，不收一段说明。</p>
              </div>
              <div className="rounded-md bg-surface-2 px-3 py-3">
                <p className="text-sm">发给 xAI 的</p>
                <p className="mt-1 text-xs text-subtle">
                  模型、填充词和静音阈值是固定的。下面的词一行一个，会作为 keyterm 发出去。最近说过的词仍会另外带上。
                </p>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed text-fg">
{`model: ${HEARING.xai.model}
filler_words: true
vad_threshold: ${DEFAULT_XAI_VAD_THRESHOLD}`}
                </pre>
                <label className="mt-3 block text-xs text-subtle" htmlFor="stt-keyterms">
                  keyterm
                </label>
                <Textarea
                  id="stt-keyterms"
                  value={keytermDraft}
                  onChange={(e) => setKeytermDraft(e.target.value)}
                  onBlur={() => {
                    const next = lockSttKeyterms(keytermDraft.split("\n"));
                    setKeytermDraft(next.join("\n"));
                    persistProfile({ sttKeyterms: next });
                  }}
                  className="mt-1 min-h-40 font-mono text-sm leading-relaxed"
                />
                <button
                  type="button"
                  className="mt-2 h-11 text-sm text-muted"
                  onClick={() => {
                    const next = [...STT_KEYTERMS];
                    setKeytermDraft(next.join("\n"));
                    persistProfile({ sttKeyterms: next });
                  }}
                >
                  恢复默认词
                </button>
              </div>
              <div className="rounded-md bg-surface-2 px-3 py-3">
                <p className="text-sm">发给 Apple 的</p>
                <p className="mt-1 text-xs text-subtle">
                  浏览器自带的中文识别，不收任何说明。只把听到的字拿回来，和 xAI 对一下，用来丢掉 xAI 胡说的句子。
                </p>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-fg">
{`lang: zh-CN
continuous: true
interimResults: true
maxAlternatives: 3`}
                </pre>
              </div>
            </section>
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
                  打开后每一句都存成 clip，并启用确认面板。关掉就不存录音，铅笔只是改字。改完要点右上角保存。
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
            {debugHearing ? <AudioTracePanel /> : null}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-2">
            <p className="text-xs text-subtle">
              {callPhase ? `通话 phase ${callPhase}${callDeaf ? " · 麦关" : ""}` : "当前不在通话"}
            </p>
            <p className="text-xs text-subtle">
              占用 {formatDbBytes(dbSize?.totalBytes ?? null)}
              {dbSize?.limitMb ? ` / ${dbSize.limitMb} MB` : ""}
              {" · "}记录保留 30 天
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={logRoute == null}
                onClick={() => setLogRoute(null)}
                className={cn(
                  "min-h-11 rounded-md px-3 text-sm",
                  logRoute == null ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
                )}
              >
                全部
              </button>
              {LOG_ROUTE_FILTERS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={logRoute === id}
                  onClick={() => setLogRoute(logRoute === id ? null : id)}
                  className={cn(
                    "min-h-11 rounded-md px-3 text-sm",
                    logRoute === id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {LOG_RANGE_FILTERS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={logRange === id}
                  onClick={() => setLogRange(id)}
                  className={cn(
                    "min-h-11 rounded-md px-3 text-sm",
                    logRange === id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {log.filter((row) => row.route === "hear" || row.step === "hearing").length ? (
              <div className="mb-2 rounded-md bg-surface-2 px-3 py-2">
                <p className="text-xs text-subtle">最近听力耗时</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {log
                    .filter((row) => row.route === "hear" || row.step === "hearing")
                    .slice(0, 20)
                    .map((row) => {
                      const timing = parseHearingTimingLine(row.note);
                      const senseLine = parseSenseLine(row.note);
                      return (
                        <li key={row.id} className="text-xs leading-relaxed text-fg">
                          <span className="text-subtle">{logClock(row.at)} </span>
                          {timing ? formatHearingTimingSummary(timing) : row.note || `${row.ms ?? "—"}ms`}
                          {senseLine ? <span className="mt-0.5 block text-subtle">{senseLine}</span> : null}
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
                const injectLine = parseVoiceInjectLine(row.note);
                const senseLine = parseSenseLine(row.note);
                const detail = callById[row.id];
                const loaded = detail && detail !== "loading" ? detail : null;
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
                      {senseLine ? <p className="mt-1 text-subtle">{senseLine}</p> : null}
                      {injectLine ? <p className="mt-1 text-subtle">{injectLine}</p> : null}
                      {row.note?.includes("状态卡住已恢复") ? (
                        <p className="mt-1 text-live">{row.note}</p>
                      ) : null}
                      {failLine ? <p className="mt-1 text-live">{failLine}</p> : null}
                    </summary>
                    <div className="mt-3 flex flex-col gap-3">
                      <section>
                        <p className="text-xs text-subtle">参数与耗时</p>
                        <dl className="mt-1 flex flex-col gap-1 text-subtle">
                          <div>模型 {row.model || "—"}{row.effort ? ` · ${row.effort}` : ""}</div>
                          <div>耗时 {row.ms != null ? `${row.ms}ms` : "—"}</div>
                          <div>
                            tokens in {row.tokensIn ?? "—"} · out {row.tokensOut ?? "—"} · cached {row.tokensCached ?? "—"}
                            {row.tokensReasoning != null ? ` · reasoning ${row.tokensReasoning}` : ""}
                          </div>
                          <div>input_chars {logInputChars(row)}</div>
                          <div>finish_reason {logFinishReason(row) || "—"}</div>
                          {row.error ? <div className="text-live">{row.error}</div> : null}
                          {row.trimmed ? <div>已截断到 200KB</div> : null}
                          {row.note ? <div className="whitespace-pre-wrap break-all">{row.note}</div> : null}
                        </dl>
                      </section>
                      <section>
                        <p className="text-xs text-subtle">输入</p>
                        {detail === "loading" || !detail ? (
                          <p className="mt-1 text-subtle">{detail === "loading" ? "正在读这一次的全文…" : "点开后会去读。"}</p>
                        ) : detail.messages.length ? (
                          <div className="mt-1 flex flex-col gap-1">
                            {detail.messages.map((msg, i) => (
                              <details key={`${row.id}-${i}`} className="rounded-md bg-bg px-2 py-1">
                                <summary className="cursor-pointer text-fg">
                                  {msg.label} · {msg.role}
                                </summary>
                                <pre className="mt-1 whitespace-pre-wrap break-all text-muted">
                                  {(row.route === "voice" || row.step.startsWith("voice")
                                    ? splitMindHighlight(msg.content)
                                    : [{ text: msg.content, mind: false }]
                                  ).map((part, j) =>
                                    part.mind ? (
                                      <mark key={j} className="bg-accent/30 text-fg">
                                        {part.text}
                                      </mark>
                                    ) : (
                                      <span key={j}>{part.text}</span>
                                    ),
                                  )}
                                  {msg.content ? "" : "（空）"}
                                </pre>
                              </details>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-1 text-subtle">这一次没有存下完整输入。</p>
                        )}
                      </section>
                      {loaded?.warnings.length ? (
                        <p className="whitespace-pre-wrap break-all text-live">{loaded.warnings.join("\n")}</p>
                      ) : null}
                      <section>
                        <p className="text-xs text-subtle">输出</p>
                        <pre className="mt-1 whitespace-pre-wrap break-all text-fg">
                          {loaded
                            ? loaded.output || "（空）"
                            : row.outputText || (row.raw ?? "").slice(0, 1000) || "—"}
                        </pre>
                      </section>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={!loaded}
                        onClick={() => loaded && void copyCall(row, loaded)}
                      >
                        {logCopied === row.id ? "已复制" : "复制全部"}
                      </Button>
                    </div>
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
    ? `system ${split.system} · 我此刻 ${split.moment} · 我记得的 ${split.dossier} · 对话历史 ${split.history} · 用户消息 ${split.user}`
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

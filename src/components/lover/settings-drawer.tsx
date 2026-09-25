import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { keepCaretVisible, useVisualViewportHeight } from "@/hooks/use-visual-viewport";
import { HEARING, STT_KEYTERMS, DEFAULT_XAI_VAD_THRESHOLD, lockSttKeyterms } from "@/lib/lover/hearing/config";
import { RECENT_CLIP_KEEP } from "@/lib/lover/brain/config";
import { formatHearingTimingSummary, parseHearingTimingLine } from "@/lib/lover/hearing/timing-format";
import { formatCallAudioLogLines, subscribeCallAudioLog } from "@/lib/lover/call-audio-log";
import {
  brainGetCallLog,
  brainGetDbSize,
  brainListLogs,
  brainListPrompts,
  brainListVoiceModels,
  brainRestorePrompt,
  brainRollbackPrompt,
  brainSavePrompt,
  brainSyncHistoryWindow,
} from "@/lib/lover/brain/api";
import type { BrainLogRow } from "@/lib/lover/brain/types";
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
import { PromptStepEditor, type PromptEditorItem, type PromptModelChoice } from "@/components/lover/prompt-step-editor";
import { HearingSensePanel } from "@/components/lover/hearing-sense-panel";
import { BrainBackupPanel } from "@/components/lover/brain-backup-panel";
import { LogoutButton } from "@/components/lover/logout-button";
import { DossierPanel } from "@/components/lover/dossier-panel";
import { BrainSpendPage } from "@/components/lover/brain-spend-page";
import { BrainSystemArchive } from "@/components/lover/brain-system-archive";
import { ReplayPanel } from "@/components/lover/replay-panel";
import {
  HeartEditor,
  IdentityField,
  ManualEdits,
  ReachPanel,
  SettingsLink,
  StatusPanel,
} from "@/components/lover/settings-life";
import { applyHearingTier, hearingTierOf, HEARING_TIER_BLURB } from "@/lib/lover/hearing/sense";
import { nextVoiceRate, snapVoiceRate } from "@/lib/lover/tts";
import { DEFAULT_SYSTEM_PROMPT, clampHistoryWindow, formatVoiceInjectLine, parseVoiceInjectLine, voiceInjectFromProfile, type HearingSense, type Profile, type VoiceEffort } from "@/lib/lover/types";
import { defaultPromptModel } from "@/lib/lover/brain/prompts/models";
import { parseSenseLine } from "@/lib/lover/hearing/sense";
import { cn } from "@/lib/utils";

type Page =
  | "home"
  | "who"
  | "heart"
  | "reach"
  | "sound"
  | "data"
  | "advanced"
  | "prompts"
  | "context"
  | "hearing"
  | "log"
  | "spend"
  | "archive"
  | "status"
  | "replay";

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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile;
  callPhase?: string | null;
  callDeaf?: boolean;
  onSave: (next: Profile) => void;
  onClearChat: () => void;
};

function LabelModeSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-md bg-surface-2 px-3 py-3">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-sm">标注模式</span>
        <span className="block text-xs text-subtle">
          打开后每一句都存成 clip。关掉时仍保留最近 {RECENT_CLIP_KEEP} 条语音，消息上可以点「听错了」改正。更早的只删录音，不删聊天。
        </span>
      </span>
    </label>
  );
}

export function SettingsDrawer({ open, onOpenChange, profile, callPhase = null, callDeaf = false, onSave, onClearChat }: Props) {
  const [draft, setDraft] = useState(profile.systemPrompt);
  const [debugHearing, setDebugHearing] = useState(profile.debugHearing);
  const [labPassword, setLabPassword] = useState("");
  const [page, setPage] = useState<Page>("home");
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
  const [log, setLog] = useState<BrainLogRow[]>([]);
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
  const [intimateDraft, setIntimateDraft] = useState(profile.intimateNotes);
  const [keytermDraft, setKeytermDraft] = useState(profile.sttKeyterms.join("\n"));
  const historySyncRef = useRef(0);
  const [promptItems, setPromptItems] = useState<PromptItem[]>([]);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [promptBusy, setPromptBusy] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [callById, setCallById] = useState<Record<number, CallDetail | "loading">>({});
  const [logRoute, setLogRoute] = useState<string | null>(null);
  const [logRange, setLogRange] = useState<LogRangeId>("7d");
  const [logCopied, setLogCopied] = useState<number | null>(null);
  const [dbSize, setDbSize] = useState<{ totalBytes: number | null; limitMb: number; warn: boolean } | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedTimer = useRef(0);
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
    setIntimateDraft(profile.intimateNotes);
    setKeytermDraft(profile.sttKeyterms.join("\n"));
    setLabPassword(typeof sessionStorage !== "undefined" ? sessionStorage.getItem("qingran-hearing-lab") ?? "" : "");
    setPage("home");
    setPromptItems([]);
    setPromptDrafts({});
    setPromptError(null);
    setCallById({});
    setClearArmed(false);
    void brainListVoiceModels()
      .then((res) => {
        setVoiceModels(res.models);
        setVoiceStats(res.stats ?? []);
      })
      .catch(() => {
        setVoiceModels([]);
        setVoiceStats([]);
      });
    // Snapshot the open profile once. Later saves must not jump back to the first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
      keepCaretVisible(active);
    }
  }, [open, viewport.height, viewport.offsetTop]);

  useEffect(() => {
    if (!open || page !== "prompts") return;
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
  }, [open, page]);

  useEffect(() => {
    if (!open || (page !== "log" && page !== "status")) return;
    let cancelled = false;
    if (page === "log" && logRoute !== "manual") {
      const to = Date.now();
      const from = to - logRangeMs(logRange);
      void brainListLogs({ data: { route: logRoute, from, to, limit: 200 } })
        .then((rows) => {
          if (!cancelled) setLog(rows as BrainLogRow[]);
        })
        .catch(() => {
          if (!cancelled) setLog([]);
        });
    }
    void brainGetDbSize()
      .then((s) => {
        if (cancelled) return;
        setDbSize({ totalBytes: s.totalBytes ?? null, limitMb: s.limitMb, warn: Boolean(s.warn) });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, page, logRoute, logRange]);

  function flashSaved() {
    setSaveError(null);
    setSavedFlash(true);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSavedFlash(false), 1200);
  }

  function persistProfile(patch: Partial<Profile>) {
    try {
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
      ...patch,
    });
      flashSaved();
    } catch {
      setSaveError("没记下。");
    }
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

  const persistRef = useRef<(patch: Partial<Profile>) => void>(() => undefined);
  persistRef.current = persistProfile;

  useEffect(() => {
    if (!open) return;
    if ((draft.trim() || DEFAULT_SYSTEM_PROMPT) === profile.systemPrompt) return;
    const timer = window.setTimeout(() => {
      persistRef.current({ systemPrompt: draft.trim() || DEFAULT_SYSTEM_PROMPT });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [draft, open, profile.systemPrompt]);

  if (!open) return null;

  const pageTitle: Record<Page, string> = {
    home: "设置",
    who: "清然是谁",
    heart: "他的心",
    reach: "主动消息",
    sound: "声音和听力",
    data: "数据",
    advanced: "高级",
    prompts: "指令",
    context: "上下文",
    hearing: "听力参数",
    log: "调用记录",
    spend: "费用",
    archive: "系统存档",
    status: "状态",
    replay: "重放对比",
  };
  const tier = hearingTierOf(sense);

  return (
    <div
      className="fixed inset-x-0 z-50 flex flex-col bg-bg"
      style={{ top: viewport.offsetTop, height: viewport.height }}
    >
      <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          aria-label={page === "home" ? "关闭" : "返回"}
          onClick={() => (page === "home" ? onOpenChange(false) : setPage(page === "prompts" || page === "context" || page === "hearing" || page === "log" || page === "spend" || page === "archive" || page === "status" || page === "replay" ? "advanced" : "home"))}
          className="grid size-11 place-items-center rounded-md text-muted"
        >
          <X className={cn("size-5", page !== "home" && "hidden")} />
          <span className={cn("text-sm", page === "home" && "hidden")}>返回</span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-medium tracking-tight">{pageTitle[page]}</p>
          <p className="text-xs text-subtle">
            {page === "home" ? "点进去改。改完自己会记下。" : "停一下就记下。"}
          </p>
        </div>
        {savedFlash ? <span className="text-xs text-subtle">已保存</span> : null}
        {saveError ? <span className="text-xs text-live">{saveError}</span> : null}
      </header>

      {page === "home" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-2">
            <SettingsLink label="清然是谁" hint="身份、人设" onClick={() => setPage("who")} />
            <SettingsLink label="他的心" hint="此刻、计划、心事、记得的" onClick={() => setPage("heart")} />
            <SettingsLink label="主动消息" hint="开关、下一次、记录" onClick={() => setPage("reach")} />
            <SettingsLink label="声音和听力" hint="语速、静音、灵敏度" onClick={() => setPage("sound")} />
            <SettingsLink label="数据" hint="备份、清空、退出" onClick={() => setPage("data")} />
            <SettingsLink label="高级" hint="指令、记录、费用" onClick={() => setPage("advanced")} />
          </div>
        </div>
      ) : page === "advanced" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-2">
            <p className="text-xs text-subtle">调试用，平时不用进。</p>
            <SettingsLink label="指令" onClick={() => setPage("prompts")} />
            <SettingsLink label="上下文" onClick={() => setPage("context")} />
            <SettingsLink label="重放对比" onClick={() => setPage("replay")} />
            <SettingsLink label="听力参数" onClick={() => setPage("hearing")} />
            <SettingsLink label="调用记录" onClick={() => setPage("log")} />
            <SettingsLink label="费用" onClick={() => setPage("spend")} />
            <SettingsLink label="系统存档" onClick={() => setPage("archive")} />
            <SettingsLink label="状态" onClick={() => setPage("status")} />
          </div>
        </div>
      ) : page === "who" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-5">
            <p className="text-xs text-subtle">身份是他在现实里是谁。人设是他怎么说话。</p>
            <IdentityField value={profile.identity} onSave={(identity) => persistProfile({ identity })} />
            <label className="flex flex-col gap-2">
              <span className="text-sm">人设</span>
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
            className="min-h-64 resize-none font-mono leading-relaxed"
            placeholder="写给模型的 system prompt"
          />
          <p className="mt-2 text-xs text-subtle">「我记得的」会另外附上，不用写进这段。其他步骤的指令在「指令」页。</p>
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-sm">亲密设定</span>
              <Textarea
                value={intimateDraft}
                onChange={(e) => setIntimateDraft(e.target.value)}
                onBlur={() => persistProfile({ intimateNotes: intimateDraft })}
                maxLength={8000}
                className="min-h-36 resize-none leading-relaxed"
                placeholder="只在亲密场景时给他看"
              />
              <p className="text-xs text-subtle">只在亲密场景时给他看。平时他只知道自己有这一面。</p>
            </label>
          </div>
        </div>
      ) : page === "context" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-3">
            <div className="flex flex-col gap-1 rounded-md bg-surface-2 px-3 py-2">
              <p className="px-1 pt-1 text-sm">这一轮带上什么</p>
            <p className="text-xs text-subtle">只影响开口那一句。</p>
              <label className="flex min-h-11 items-center gap-3 rounded-md px-1">
                <input
                  type="checkbox"
                  checked={injectMind}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setInjectMind(next);
                    persistProfile({ injectMind: next });
                  }}
                />
                <span className="text-sm">注入我此刻</span>
              </label>
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
              <div className="flex flex-col gap-1 px-1 pb-2">
                <p className="text-sm">人设放在哪</p>
                <p className="text-xs text-subtle">系统提示，或者聊天记录里的第一条消息。主动找她也照这个来。</p>
                {(["system", "first_user"] as const).map((id) => (
                  <label key={id} className="flex min-h-11 items-center gap-3">
                    <input
                      type="radio"
                      name="persona-placement"
                      checked={profile.personaPlacement === id}
                      onChange={() => persistProfile({ personaPlacement: id })}
                    />
                    <span className="text-sm">{id === "system" ? "系统提示" : "第一条消息"}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : page === "prompts" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-3">
            <p className="text-xs text-subtle">
              点开一步改消息。人设在「清然是谁」，这里用 {"{system_prompt}"} 引用。记下后下一轮生效。
            </p>
            {promptError ? <p className="text-sm text-live">{promptError}</p> : null}
            {promptItems.length === 0 ? (
              <p className="text-sm text-subtle">正在读指令…</p>
            ) : (
              [
                ["清然", ["voice", "reach", "editor", "busy", "busy_tool", "persona_ack"]],
                ["日记", ["report"]],
                ["评审", ["judge"]],
              ].map(([title, keys]) => (
                <div key={String(title)} className="flex flex-col gap-2">
                  <p className="text-xs text-subtle">{title}</p>
                  {(keys as string[])
                    .map((key) => promptItems.find((item) => item.key === key))
                    .filter((item): item is PromptItem => Boolean(item))
                    .map((item) => {
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
                    })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : page === "heart" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-6">
            <p className="text-xs text-subtle">这些他都能看见。你改的会记下来。</p>
            <HeartEditor
              halfLifeDays={profile.glowHalfLifeDays}
              onHalfLife={(days) => persistProfile({ glowHalfLifeDays: days })}
            />
            <DossierPanel maxChars={profile.dossierMaxChars} onMaxChars={(n) => persistProfile({ dossierMaxChars: n })} />
          </div>
        </div>
      ) : page === "reach" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto w-full max-w-md">
            <ReachPanel />
          </div>
        </div>
      ) : page === "sound" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <p className="text-xs text-subtle">语速和静音跟主屏幕是同一个。</p>
            <div className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-3">
              <span className="text-sm">语速 {snapVoiceRate(profile.voiceSpeed).label}</span>
              <Button type="button" variant="outline" onClick={() => persistProfile({ voiceSpeed: nextVoiceRate(profile.voiceSpeed).speed })}>
                换一档
              </Button>
            </div>
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={profile.muted}
                onChange={(e) => persistProfile({ muted: e.target.checked })}
              />
              <span className="text-sm">静音</span>
            </label>
            <LabelModeSwitch
              checked={debugHearing}
              onChange={(next) => {
                setDebugHearing(next);
                persistProfile({ debugHearing: next, captureAudio: next });
              }}
            />
            <div className="flex flex-col gap-2">
              <p className="text-sm">听力灵敏度</p>
              {(["low", "mid", "high"] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => commitSense(applyHearingTier(sense, id))}
                  className={cn(
                    "rounded-md px-3 py-3 text-left",
                    tier === id ? "bg-accent text-accent-fg" : "bg-surface-2",
                  )}
                >
                  <span className="block text-sm">{id === "low" ? "低" : id === "mid" ? "中" : "高"}</span>
                  <span className="block text-xs opacity-80">{HEARING_TIER_BLURB[id]}</span>
                </button>
              ))}
              {tier === "custom" ? (
                <div className="flex items-center justify-between">
                  <span className="text-sm">自定义</span>
                  <button type="button" className="text-sm text-muted" onClick={() => commitSense(applyHearingTier(sense, "mid"))}>
                    恢复为 中
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : page === "data" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <p className="text-xs text-subtle">备份里有他记得的、心里的、和日程。</p>
            <BrainBackupPanel />
            <LogoutButton />
            {!clearArmed ? (
              <Button variant="outline" onClick={() => setClearArmed(true)}>
                清空聊天
              </Button>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-subtle">
                  清掉屏幕上的聊天和最近还没整理进记忆的对话，并放下他手上的计划，适合他轴在一个话题上的时候用。他的心事、心情和已经记住的事都还在。
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
      ) : page === "spend" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <BrainSpendPage />
        </div>
      ) : page === "archive" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <BrainSystemArchive />
        </div>
      ) : page === "status" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto w-full max-w-md">
            <StatusPanel
              voiceModel={voiceModel}
              injectLine={formatVoiceInjectLine(voiceInjectFromProfile({ injectMind, injectLongterm, historyWindow }))}
              phase={callPhase ? `通话 phase ${callPhase}${callDeaf ? " · 麦关" : ""}` : "当前不在通话"}
            />
            <p className="mt-3 text-xs text-subtle">
              占用 {formatDbBytes(dbSize?.totalBytes ?? null)}
              {dbSize?.limitMb ? ` / ${dbSize.limitMb} MB` : ""}
            </p>
          </div>
        </div>
      ) : page === "replay" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <ReplayPanel profile={profile} />
        </div>
      ) : page === "hearing" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-5">
            <details className="rounded-md bg-surface-2 px-3 py-2">
              <summary className="min-h-11 cursor-pointer text-sm">具体参数</summary>
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
            </details>
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
            <LabelModeSwitch
              checked={debugHearing}
              onChange={(next) => {
                setDebugHearing(next);
                persistProfile({ debugHearing: next, captureAudio: next });
              }}
            />
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
            {logRoute === "manual" ? (
              <ManualEdits />
            ) : log.length === 0 ? (
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

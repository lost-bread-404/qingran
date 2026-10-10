import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { keepCaretVisible, useVisualViewportHeight } from "@/hooks/use-visual-viewport";
import { HEARING, STT_KEYTERMS, DEFAULT_XAI_VAD_THRESHOLD, lockSttKeyterms } from "@/lib/lover/hearing/config";
import { RECENT_CLIP_KEEP } from "@/lib/lover/brain/config";
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
} from "@/lib/lover/brain/api";
import type { BrainLogRow } from "@/lib/lover/brain/types";
import { formatDbBytes, LOG_ROUTE_FILTERS, messagesText } from "@/lib/lover/call-log-view";
import { FullText, PromptStepEditor, type PromptEditorItem, type PromptModelChoice } from "@/components/lover/prompt-step-editor";
import { HearingSensePanel } from "@/components/lover/hearing-sense-panel";
import { StatePanel } from "@/components/lover/state-panel";
import { LogoutButton } from "@/components/lover/logout-button";
import { DossierPanel } from "@/components/lover/dossier-panel";
import { NightPanel } from "@/components/lover/night-panel";
import { ModelPick, type ModelOption, type ModelStat } from "@/components/lover/model-pick";
import { BrainSpendPage } from "@/components/lover/brain-spend-page";
import { ReplayPanel } from "@/components/lover/replay-panel";
import { VoicePanel } from "@/components/lover/voice-panel";
import { CharactersPanel, useVoiceChoices } from "@/components/lover/characters-panel";
import { ProfileHistory, VersionConflict } from "@/components/lover/profile-history";
import { saveProfilePatch } from "@/lib/lover/room";
import type { FieldRevs, VersionedField } from "@/lib/lover/profile-patch";
import {
  IdentityField,
  ManualEdits,
  ReachPanel,
  SettingsLink,
} from "@/components/lover/settings-life";
import { applyHearingTier, hearingTierOf, HEARING_TIER_BLURB } from "@/lib/lover/hearing/sense";
import { nextVoiceRate, snapVoiceRate } from "@/lib/lover/tts";
import { clampVoiceTemperature, type HearingSense, type Profile, type VoiceEffort } from "@/lib/lover/types";
import { defaultPromptModel } from "@/lib/lover/brain/prompts/models";
import { cn } from "@/lib/utils";

type Page =
  | "home"
  | "who"
  | "heart"
  | "reply"
  | "reach"
  | "sound"
  | "data"
  | "advanced"
  | "prompts"
  | "hearing"
  | "log"
  | "spend";

type PromptItem = PromptEditorItem;

type CallDetail = {
  messages: Array<{ role: string; content: string }>;
  warnings: string[];
  output: string;
};

/** 指令 page (月报 only): a model option in the step editor's shape. */
function toModelChoices(models: ModelOption[], stats: ModelStat[]): PromptModelChoice[] {
  const byModel = new Map(stats.map((row) => [row.model, row]));
  return models
    .filter((m) => !m.id.startsWith("claude-"))
    .map((m) => {
      const st = byModel.get(m.id);
      return {
        id: m.id,
        blurb: m.blurb,
        supportsEffort: m.efforts.some((e) => e != null),
        stats: st ? { n: st.n, avgMs: st.avgMs, avgTtftMs: null, emptyRate: null } : null,
      };
    });
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile;
  revs: FieldRevs;
  /** Set while a call is on: samples must not play into the mic. */
  callPhase?: string | null;
  onPatch: (patch: Partial<Profile>) => void;
  onApply: (profile: Profile, revs: FieldRevs) => void;
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

export function SettingsDrawer({ open, onOpenChange, profile, revs, callPhase = null, onPatch, onApply, onClearChat }: Props) {
  const [draft, setDraft] = useState(profile.systemPrompt);
  const personaDirty = useRef(false);
  const [debugHearing, setDebugHearing] = useState(profile.debugHearing);
  const [labPassword, setLabPassword] = useState("");
  const [page, setPage] = useState<Page>("home");
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
  const [log, setLog] = useState<BrainLogRow[]>([]);
  const [clearArmed, setClearArmed] = useState(false);
  const [voiceModel, setVoiceModel] = useState(profile.voiceModel);
  const [voiceEffort, setVoiceEffort] = useState<VoiceEffort>(profile.voiceEffort);
  const [voiceModels, setVoiceModels] = useState<ModelOption[] | null>(null);
  const [voiceStats, setVoiceStats] = useState<ModelStat[]>([]);
  const [nightStats, setNightStats] = useState<ModelStat[]>([]);
  const [reachStats, setReachStats] = useState<ModelStat[]>([]);
  const [promptModels, setPromptModels] = useState(profile.promptModels);
  const [sense, setSense] = useState<HearingSense>(profile.hearingSense);
  const [brainOn, setBrainOn] = useState(profile.brainOn);
  const voiceChoices = useVoiceChoices(open);
  useEffect(() => {
    setBrainOn(profile.brainOn);
  }, [profile.brainOn]);
  const [injectLongterm, setInjectLongterm] = useState(profile.injectLongterm);
  const [voiceTemperature, setVoiceTemperature] = useState(profile.voiceTemperature);
  const temperatureSave = useRef<number | undefined>(undefined);
  const [intimateDraft, setIntimateDraft] = useState(profile.intimateNotes);
  const [identityDraft, setIdentityDraft] = useState(profile.identity);
  const identityDirty = useRef(false);
  const intimateDirty = useRef(false);
  const [conflict, setConflict] = useState<{ field: VersionedField; latest: string } | null>(null);
  const revsRef = useRef(revs);
  const loadedPersona = useRef(profile.systemPrompt);
  const loadedIntimate = useRef(profile.intimateNotes);
  const loadedIdentity = useRef(profile.identity);
  const [keytermDraft, setKeytermDraft] = useState(profile.sttKeyterms.join("\n"));
  const [promptItems, setPromptItems] = useState<PromptItem[]>([]);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [promptBusy, setPromptBusy] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [callById, setCallById] = useState<Record<number, CallDetail | "loading">>({});
  const [logRoute, setLogRoute] = useState<string | null>(null);
  const [dbSize, setDbSize] = useState<{ totalBytes: number | null; limitMb: number; warn: boolean } | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedTimer = useRef(0);
  const viewport = useVisualViewportHeight(open);

  useEffect(() => {
    if (!open) return;
    if (!personaDirty.current) setDraft(profile.systemPrompt);
    setDebugHearing(profile.debugHearing);
    setVoiceModel(profile.voiceModel);
    setVoiceEffort(profile.voiceEffort);
    setPromptModels(profile.promptModels);
    setSense(profile.hearingSense);
    setInjectLongterm(profile.injectLongterm);
    setVoiceTemperature(profile.voiceTemperature);
    if (!intimateDirty.current) setIntimateDraft(profile.intimateNotes);
    if (!identityDirty.current) setIdentityDraft(profile.identity);
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
        setNightStats(res.nightStats ?? []);
        setReachStats(res.reachStats ?? []);
      })
      .catch(() => setVoiceModels([]));
    // Snapshot the open profile once. Later saves must not jump back to the first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    if (!open || page !== "log") return;
    let cancelled = false;
    if (page === "log" && logRoute !== "manual") {
      const to = Date.now();
      const from = to - 30 * 86_400_000;
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
  }, [open, page, logRoute]);

  function flashSaved() {
    setSaveError(null);
    setSavedFlash(true);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSavedFlash(false), 1200);
  }

  function rememberLoaded(next: Profile) {
    loadedPersona.current = next.systemPrompt;
    loadedIntimate.current = next.intimateNotes;
    loadedIdentity.current = next.identity;
  }

  async function commitProfile(patch: Partial<Profile>) {
    const baseRevs: Partial<FieldRevs> = {};
    if ("systemPrompt" in patch) baseRevs.systemPrompt = revsRef.current.systemPrompt;
    if ("intimateNotes" in patch) baseRevs.intimateNotes = revsRef.current.intimateNotes;
    if ("identity" in patch) baseRevs.identity = revsRef.current.identity;
    try {
      const result = await saveProfilePatch({ data: { patch, baseRevs } });
      if (!result.ok) {
        revsRef.current = result.revs;
        rememberLoaded(result.profile);
        onApply(result.profile, result.revs);
        setConflict({ field: result.field, latest: result.latest });
        setSaveError(null);
        return;
      }
      revsRef.current = result.revs;
      rememberLoaded(result.profile);
      if ("systemPrompt" in patch && draftRef.current.trim() === String(patch.systemPrompt ?? "").trim()) {
        personaDirty.current = false;
      }
      if ("intimateNotes" in patch && intimateRef.current.trim() === String(patch.intimateNotes ?? "").trim()) {
        intimateDirty.current = false;
      }
      if ("identity" in patch && identityRef.current.trim() === String(patch.identity ?? "").trim()) {
        identityDirty.current = false;
      }
      onApply(result.profile, result.revs);
      setConflict((cur) => (cur && cur.field in patch ? null : cur));
      flashSaved();
    } catch {
      setSaveError("没记下。");
    }
  }

  function persistProfile(patch: Partial<Profile>) {
    const fast = { ...patch };
    delete fast.systemPrompt;
    delete fast.intimateNotes;
    delete fast.identity;
    if (Object.keys(fast).length) onPatch(fast);
    void commitProfile(patch);
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
            messages: assembled ?? [],
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



  const persistRef = useRef<(patch: Partial<Profile>) => void>(() => undefined);
  const draftRef = useRef(draft);
  const intimateRef = useRef(intimateDraft);
  const identityRef = useRef(identityDraft);
  persistRef.current = persistProfile;
  draftRef.current = draft;
  intimateRef.current = intimateDraft;
  identityRef.current = identityDraft;

  useEffect(() => {
    revsRef.current = revs;
  }, [revs]);

  useEffect(() => {
    if (!personaDirty.current) {
      loadedPersona.current = profile.systemPrompt;
      setDraft(profile.systemPrompt);
      return;
    }
    if (profile.systemPrompt !== loadedPersona.current) {
      loadedPersona.current = profile.systemPrompt;
      setConflict((cur) => (cur && cur.field !== "systemPrompt" ? cur : { field: "systemPrompt", latest: profile.systemPrompt }));
    }
  }, [profile.systemPrompt]);

  useEffect(() => {
    if (!intimateDirty.current) {
      loadedIntimate.current = profile.intimateNotes;
      setIntimateDraft(profile.intimateNotes);
      return;
    }
    if (profile.intimateNotes !== loadedIntimate.current) {
      loadedIntimate.current = profile.intimateNotes;
      setConflict((cur) => (cur && cur.field !== "intimateNotes" ? cur : { field: "intimateNotes", latest: profile.intimateNotes }));
    }
  }, [profile.intimateNotes]);

  useEffect(() => {
    if (!identityDirty.current) {
      loadedIdentity.current = profile.identity;
      setIdentityDraft(profile.identity);
      return;
    }
    if (profile.identity !== loadedIdentity.current) {
      loadedIdentity.current = profile.identity;
      setConflict((cur) => (cur && cur.field !== "identity" ? cur : { field: "identity", latest: profile.identity }));
    }
  }, [profile.identity]);

  useEffect(() => {
    if (!open || !personaDirty.current || conflict?.field === "systemPrompt") return;
    const next = draft.trim();
    if (next === profile.systemPrompt.trim()) return;
    const timer = window.setTimeout(() => {
      persistRef.current({ systemPrompt: next });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [draft, open, profile.systemPrompt, conflict]);

  if (!open) return null;

  const pageTitle: Record<Page, string> = {
    home: "设置",
    who: "人设",
    heart: "记忆",
    reply: "回复",
    reach: "主动消息",
    sound: "声音和听力",
    data: "数据",
    advanced: "高级",
    prompts: "指令",
    hearing: "听力参数",
    log: "记录",
    spend: "费用",
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
          onClick={() => {
            // Close the keyboard first: the field saves on blur, and the next page is laid out without it.
            const active = document.activeElement;
            if (active instanceof HTMLElement) active.blur();
            if (page === "home") onOpenChange(false);
            else setPage(page === "prompts" || page === "hearing" || page === "log" || page === "spend" ? "advanced" : "home");
          }}
          className="grid size-11 place-items-center rounded-md text-muted"
        >
          <X className={cn("size-5", page !== "home" && "hidden")} />
          <span className={cn("text-sm", page === "home" && "hidden")}>返回</span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-medium tracking-tight">{pageTitle[page]}</p>
        </div>
        {savedFlash ? <span className="text-xs text-subtle">已保存</span> : null}
        {saveError ? <span className="text-xs text-live">{saveError}</span> : null}
      </header>

      {/* Each page is its own element: it opens at the top, and nothing (scroll, focus) carries over from the last one. */}
      <div key={page} className="flex min-h-0 flex-1 flex-col">
      {page === "home" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-2">
            <SettingsLink label="人设" hint="清然、其他角色、声音" onClick={() => setPage("who")} />
            <SettingsLink label="记忆" hint="dossier、夜里整理、你的抱怨" onClick={() => setPage("heart")} />
            <SettingsLink label="回复" hint="模型、长度、温度" onClick={() => setPage("reply")} />
            <SettingsLink label="主动消息" hint="开关、记录" onClick={() => setPage("reach")} />
            <SettingsLink label="声音和听力" hint="语速、通话" onClick={() => setPage("sound")} />
            <SettingsLink label="数据" hint="导出、导入、清空、退出" onClick={() => setPage("data")} />
            <SettingsLink label="高级" hint="调试用" onClick={() => setPage("advanced")} />
          </div>
        </div>
      ) : page === "advanced" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-2">
            <SettingsLink label="指令" hint="原文和模型" onClick={() => setPage("prompts")} />
            <SettingsLink label="记录" hint="调用、改动、重放" onClick={() => setPage("log")} />
            <SettingsLink label="费用" onClick={() => setPage("spend")} />
            <SettingsLink label="听力参数" onClick={() => setPage("hearing")} />
          </div>
        </div>
      ) : page === "who" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-5">
            <p className="font-display text-lg">清然</p>
            <IdentityField
              value={identityDraft}
              paused={conflict?.field === "identity"}
              onChange={(next) => {
                identityDirty.current = true;
                setIdentityDraft(next);
              }}
              onCommit={() => {
                const next = identityDraft.trim();
                if (next === profile.identity.trim()) {
                  identityDirty.current = false;
                  return;
                }
                persistProfile({ identity: next });
              }}
            />
            {conflict?.field === "identity" ? (
              <VersionConflict
                latest={conflict.latest}
                onUseLatest={() => {
                  identityDirty.current = false;
                  setIdentityDraft(conflict.latest);
                  setConflict(null);
                }}
                onKeepMine={() => persistProfile({ identity: identityDraft.trim() })}
              />
            ) : null}
            <label className="flex flex-col gap-2">
              <span className="text-sm">人设</span>
          <Textarea
            value={draft}
            onChange={(e) => {
              personaDirty.current = true;
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
            placeholder="写给他的人设。空着时只会告诉他：你是清然。"
          />
          {conflict?.field === "systemPrompt" ? (
            <VersionConflict
              latest={conflict.latest}
              onUseLatest={() => {
                personaDirty.current = false;
                setDraft(conflict.latest);
                setConflict(null);
              }}
              onKeepMine={() => persistProfile({ systemPrompt: draft.trim() })}
            />
          ) : null}
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-sm">亲密设定</span>
              <Textarea
                value={intimateDraft}
                onChange={(e) => {
                  intimateDirty.current = true;
                  setIntimateDraft(e.target.value);
                }}
                onBlur={() => {
                  if (conflict?.field === "intimateNotes") return;
                  const next = intimateDraft.trim();
                  if (next === profile.intimateNotes.trim()) {
                    intimateDirty.current = false;
                    return;
                  }
                  persistProfile({ intimateNotes: next });
                }}
                maxLength={8000}
                className="min-h-36 resize-none leading-relaxed"
                placeholder="清然在床上是什么样的人。每一轮都带着，接在人设后面。"
              />
              {conflict?.field === "intimateNotes" ? (
                <VersionConflict
                  latest={conflict.latest}
                  onUseLatest={() => {
                    intimateDirty.current = false;
                    setIntimateDraft(conflict.latest);
                    setConflict(null);
                  }}
                  onKeepMine={() => persistProfile({ intimateNotes: intimateDraft.trim() })}
                />
              ) : null}
            </label>
            <label className="flex min-h-11 items-center justify-between gap-3">
              <span className="font-display text-lg">其他角色</span>
              <input type="checkbox" checked={profile.castOn} onChange={(e) => persistProfile({ castOn: e.target.checked })} />
            </label>
            {profile.castOn ? (
              <CharactersPanel
                characters={profile.characters}
                othersVoice={profile.othersVoice}
                voices={voiceChoices}
                inCall={callPhase != null}
                onSave={(patch) => persistProfile(patch)}
              />
            ) : (
              <p className="text-xs text-subtle">关着时，所有话都用清然的声音。</p>
            )}
            <label className="flex min-h-11 items-center justify-between gap-3">
              <span className="font-display text-lg">心里话</span>
              <input type="checkbox" checked={profile.innerOn} onChange={(e) => persistProfile({ innerOn: e.target.checked })} />
            </label>
            {profile.innerOn ? (
              <InnerRulesBox value={profile.innerRules} onSave={(innerRules) => persistProfile({ innerRules })} />
            ) : (
              <p className="text-xs text-subtle">关着时不告诉他｛｝，他写了也不记。</p>
            )}
            <VoicePanel inCall={callPhase != null} />
          </div>
        </div>
      ) : page === "prompts" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-3">
            {promptError ? <p className="text-sm text-live">{promptError}</p> : null}
            {promptItems.length === 0 ? (
              <p className="text-sm text-subtle">正在读指令…</p>
            ) : (
              [
                ["清然", ["voice", "editor"]],
                ["日记", ["report"]],
                ["材料", ["formats"]],
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
                      : toModelChoices(voiceModels, voiceStats)
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
            <div className="flex flex-col gap-1 rounded-md bg-surface-2 px-3 py-2">
              <label className="flex min-h-11 items-center gap-3 rounded-md px-1">
                <input
                  type="checkbox"
                  checked={brainOn}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setBrainOn(next);
                    persistProfile({ brainOn: next });
                  }}
                />
                <span className="text-sm">运行记忆{brainOn ? "" : "（已暂停：只用人设 + 上下文，不整理、不主动找你）"}</span>
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
                <span className="text-sm">回复时带上 dossier</span>
              </label>
            </div>
            <div className="flex flex-col gap-2 rounded-md bg-surface-2 px-4 py-3">
              <ModelPick
                label="夜里整理用哪个模型"
                models={voiceModels}
                stats={nightStats}
                model={profile.nightModel}
                effort={profile.nightEffort}
                timeWord="每次整理"
                onChange={(model, effort) => persistProfile({ nightModel: model, nightEffort: effort })}
              />
            </div>
            <DossierPanel maxChars={profile.dossierMaxChars} onMaxChars={(n) => persistProfile({ dossierMaxChars: n })} />
            <NightPanel />
          </div>
        </div>
      ) : page === "reply" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-3">
            <div className="flex flex-col gap-2 rounded-md bg-surface-2 px-4 py-3">
              <ModelPick
                label="白天谁回你"
                models={voiceModels}
                stats={voiceStats}
                model={voiceModel}
                effort={voiceEffort}
                timeWord="每句"
                onChange={(model, effort) => persistPromptModel("voice", model, effort)}
              />
              <label className="flex items-center justify-between gap-3 pt-1">
                <span className="text-sm">回复最长（字，0 = 不限）</span>
                <input
                  key={profile.replyMaxChars}
                  type="number"
                  min={0}
                  max={2000}
                  defaultValue={profile.replyMaxChars}
                  onBlur={(e) => {
                    const next = Math.max(0, Math.min(2000, Math.round(Number(e.target.value) || 0)));
                    if (next !== profile.replyMaxChars) persistProfile({ replyMaxChars: next });
                  }}
                  className="min-h-11 w-20 rounded-md bg-surface px-2 text-right text-sm tabular-nums"
                />
              </label>
              <p className="text-xs text-subtle">0 = 不限。</p>
            </div>
            <div className="flex flex-col gap-1 rounded-md bg-surface-2 px-3 py-2">
              <div className="px-1 pb-2">
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <p className="text-sm">温度（越高越有主见、越出人意料）</p>
                  <p className="text-sm tabular-nums">{voiceTemperature.toFixed(2)}</p>
                </div>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={voiceTemperature}
                  aria-label="温度"
                  onChange={(e) => {
                    const next = clampVoiceTemperature(Number(e.target.value));
                    setVoiceTemperature(next);
                    // Saved once she stops moving it, not on every step of the drag (on the iPhone the drag can end
                    // without a pointerup or blur, so those would sometimes not save at all).
                    window.clearTimeout(temperatureSave.current);
                    temperatureSave.current = window.setTimeout(() => persistProfile({ voiceTemperature: next }), 400);
                  }}
                  className="h-11 w-full accent-accent"
                />
                <p className="text-xs text-subtle">只对 Grok 有效。</p>
              </div>
              <div className="flex flex-col gap-1 px-1 pb-2">
                <p className="text-sm">人设放在哪</p>
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
                {profile.personaPlacement === "first_user" ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-subtle">人设之后他接的那一句（固定的一句，不调用模型）</span>
                    <Textarea
                      key={profile.personaAck}
                      defaultValue={profile.personaAck}
                      className="min-h-11"
                      onBlur={(e) => {
                        const next = e.target.value.trim() || "嗯。";
                        if (next !== profile.personaAck) persistProfile({ personaAck: next });
                      }}
                    />
                  </label>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : page === "reach" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-3">
            <div className="flex flex-col gap-2 rounded-md bg-surface-2 px-4 py-3">
              <ModelPick
                label="主动找你用哪个模型"
                models={voiceModels}
                stats={reachStats}
                model={profile.reachModel}
                effort={profile.reachEffort}
                timeWord="每次"
                onChange={(model, effort) => persistProfile({ reachModel: model, reachEffort: effort })}
              />
            </div>
            <ReachPanel />
          </div>
        </div>
      ) : page === "sound" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
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
            <p className="text-xs text-subtle">通话时点挂断键左 / 右边的空白，把这句加进你说的话。</p>
            {(["tapLeft", "tapRight"] as const).map((key) => (
              <label key={key} className="flex flex-col gap-1">
                <span className="text-xs text-subtle">{key === "tapLeft" ? "左边" : "右边"}</span>
                <Textarea
                  key={profile[key]}
                  defaultValue={profile[key]}
                  className="min-h-11"
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next !== profile[key]) persistProfile({ [key]: next });
                  }}
                />
              </label>
            ))}
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
            <StatePanel />
            <LogoutButton />
            {!clearArmed ? (
              <Button variant="outline" onClick={() => setClearArmed(true)}>
                清空聊天
              </Button>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-subtle">
                  清掉屏幕上的聊天、还没整理的对话和他记着的｛｝。dossier 还在。
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
            <section className="flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-3">
              <label className="text-sm" htmlFor="stt-keyterms">
                发给 xAI 的 keyterm
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
                className="min-h-40 font-mono text-sm leading-relaxed"
              />
              <button
                type="button"
                className="h-11 self-start text-sm text-muted"
                onClick={() => {
                  const next = [...STT_KEYTERMS];
                  setKeytermDraft(next.join("\n"));
                  persistProfile({ sttKeyterms: next });
                }}
              >
                恢复默认词
              </button>
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-subtle">
{`xAI: model ${HEARING.xai.model} · filler_words true · vad_threshold ${DEFAULT_XAI_VAD_THRESHOLD}
Apple: zh-CN · continuous · interimResults · maxAlternatives 3`}
              </pre>
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
              占用 {formatDbBytes(dbSize?.totalBytes ?? null)}
              {dbSize?.limitMb ? ` / ${dbSize.limitMb} MB` : ""}
            </p>
            {/* Above the call list, which only grows (she, 10/9: at the bottom she had to scroll forever). */}
            <details className="rounded-md bg-surface-2 px-3 py-2">
              <summary className="min-h-11 cursor-pointer text-sm">重放对比（同一句换个人设或模型再回一次）</summary>
              <div className="mt-2">
                <ReplayPanel profile={profile} models={voiceModels} stats={voiceStats} />
              </div>
            </details>
            <details className="rounded-md bg-surface-2 px-3 py-2">
              <summary className="min-h-11 cursor-pointer text-sm">改动记录（人设、亲密设定、身份）</summary>
              <div className="mt-2">
                <ProfileHistory
                onRestored={(next, nextRevs, field) => {
                  if (field === "systemPrompt") personaDirty.current = false;
                  if (field === "intimateNotes") intimateDirty.current = false;
                  if (field === "identity") identityDirty.current = false;
                  revsRef.current = nextRevs;
                  rememberLoaded(next);
                  onApply(next, nextRevs);
                  setConflict(null);
                  flashSaved();
                }}
                />
              </div>
            </details>
            <div className="flex flex-wrap gap-2">
              {([[null, "全部"], ...LOG_ROUTE_FILTERS] as Array<[string | null, string]>).map(([id, label]) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={logRoute === id}
                  onClick={() => setLogRoute(id)}
                  className={cn("min-h-11 rounded-md px-3 text-sm", logRoute === id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted")}
                >
                  {label}
                </button>
              ))}
            </div>
            {logRoute === "manual" ? (
              <ManualEdits />
            ) : log.length === 0 ? (
              <p className="text-sm text-subtle">还没有调用记录。</p>
            ) : (
              log.map((row) => {
                const detail = callById[row.id];
                return (
                  <details
                    key={row.id}
                    className="rounded-md bg-surface-2 px-3 py-2 text-xs"
                    onToggle={(e) => {
                      if (e.currentTarget.open) loadCall(row);
                    }}
                  >
                    <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2">
                      <span className={cn("min-w-0 truncate", row.ok ? "text-fg" : "text-live")}>
                        {logClock(row.at)} · {row.step}
                        {row.ok ? "" : ` · ${logFailFirstLine(row)}`}
                      </span>
                      <span className="shrink-0 text-subtle">{row.ms != null ? `${(row.ms / 1000).toFixed(1)}s` : ""}</span>
                    </summary>
                    {detail === "loading" || !detail ? (
                      <p className="py-2 text-subtle">在读…</p>
                    ) : (
                      <FullText note={logMetaLine(row)} text={callText(row, detail)} />
                    )}
                  </details>
                );
              })
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

function logFailFirstLine(row: BrainLogRow): string {
  const src = (row.note || row.error || "").trim();
  if (!src) return "";
  return src.split(/\r?\n/, 1)[0] ?? "";
}


function logClock(at: number): string {
  try {
    return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

/** Model, tokens and how it ended, one line. */
function logMetaLine(row: BrainLogRow): string {
  const tokens = row.tokensIn != null ? `in ${row.tokensIn} · out ${row.tokensOut ?? "—"}${row.tokensCached ? ` · cached ${row.tokensCached}` : ""}` : "";
  return [row.model, row.effort, tokens, logFinishReason(row)].filter(Boolean).join(" · ");
}

/** The whole call as plain text: every message sent, what came back, and the note if there is one. */
function callText(row: BrainLogRow, detail: CallDetail): string {
  const parts = [];
  if (detail.messages.length) parts.push(messagesText(detail.messages));
  if (detail.warnings.length) parts.push(`══ 注意 ══\n${detail.warnings.join("\n")}`);
  parts.push(`══ 模型回的 ══\n${detail.output || row.outputText || (row.raw ?? "").slice(0, 2000) || "（空）"}`);
  if (row.error) parts.push(`══ 出错 ══\n${row.error}`);
  if (row.note) parts.push(`══ 备注 ══\n${row.note}`);
  return parts.join("\n\n");
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

/** 心里话: how he uses ｛｝, saved when she leaves the box. */
function InnerRulesBox({ value, onSave }: { value: string; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return (
    <Textarea
      value={draft}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        editing.current = false;
        const next = draft.trim();
        if (next !== value.trim()) onSave(next);
      }}
      maxLength={4000}
      className="min-h-28 resize-none leading-relaxed"
      placeholder="｛｝怎么用。空着就什么都不说。"
    />
  );
}

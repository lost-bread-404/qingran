import { Check, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { backupFilename, makeBackup, parseBackup, type QingranBackup } from "@/lib/lover/backup";
import { LogoutButton } from "@/components/lover/logout-button";
import { HEARING_PROVIDERS, type HearingProviderId } from "@/lib/lover/hearing/config";
import {
  resolveManualMemory,
  sortMemoriesByTime,
  splitLeadingTimestamp,
  toDatetimeLocal,
} from "@/lib/lover/memory";
import { DEFAULT_SYSTEM_PROMPT, type ChatMessage, type Memory, type Profile } from "@/lib/lover/types";
import { cn } from "@/lib/utils";

type Tab = "prompt" | "memory" | "backup" | "hearing";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile;
  memories: Memory[];
  messages: ChatMessage[];
  onSave: (next: Profile) => void;
  onAddMemory: (text: string, at?: number) => void;
  onUpdateMemory: (id: string, text: string, at?: number) => void;
  onDeleteMemory: (id: string) => void;
  onConsolidateMemories: () => Promise<void>;
  onClearChat: () => void;
  onRestoreBackup: (backup: QingranBackup) => Promise<void>;
};

const PROVIDER_LABEL: Record<HearingProviderId, string> = {
  xai: "xAI（现有）",
  qwen: "Qwen",
  gemini: "Gemini",
  selfhost: "自部署",
};

export function SettingsDrawer({
  open,
  onOpenChange,
  profile,
  memories,
  messages,
  onSave,
  onAddMemory,
  onUpdateMemory,
  onDeleteMemory,
  onConsolidateMemories,
  onClearChat,
  onRestoreBackup,
}: Props) {
  const [draft, setDraft] = useState(profile.systemPrompt);
  const [hearingProvider, setHearingProvider] = useState<HearingProviderId>(profile.hearingProvider);
  const [captureAudio, setCaptureAudio] = useState(profile.captureAudio);
  const [scriptedCapture, setScriptedCapture] = useState(profile.scriptedCapture);
  const [debugHearing, setDebugHearing] = useState(profile.debugHearing);
  const [hearingNbest, setHearingNbest] = useState(profile.hearingNbest);
  const [newFact, setNewFact] = useState("");
  const [newAt, setNewAt] = useState(() => toDatetimeLocal(Date.now()));
  const [newTimeTouched, setNewTimeTouched] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editAt, setEditAt] = useState("");
  const [tab, setTab] = useState<Tab>("prompt");
  const [consolidating, setConsolidating] = useState(false);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setDraft(profile.systemPrompt);
      setHearingProvider(profile.hearingProvider);
      setCaptureAudio(profile.captureAudio);
      setScriptedCapture(profile.scriptedCapture);
      setDebugHearing(profile.debugHearing);
      setHearingNbest(profile.hearingNbest);
      setTab("prompt");
      setNewAt(toDatetimeLocal(Date.now()));
      setNewTimeTouched(false);
      setEditingId(null);
    }
  }, [open, profile]);

  function save() {
    onSave({
      ...profile,
      systemPrompt: draft.trim() || DEFAULT_SYSTEM_PROMPT,
      hearingProvider,
      captureAudio,
      scriptedCapture,
      debugHearing,
      hearingNbest,
    });
    onOpenChange(false);
  }

  function commitNewMemory() {
    const resolved = resolveManualMemory(newFact, newAt, newTimeTouched);
    if (!resolved.text) return;
    onAddMemory(resolved.text, resolved.at);
    setNewFact("");
    setNewAt(toDatetimeLocal(Date.now()));
    setNewTimeTouched(false);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg">
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
          <p className="text-xs text-subtle">改 prompt 或记忆，点保存才生效。</p>
        </div>
        <Button type="button" size="pill" onClick={save}>
          保存
        </Button>
      </header>

      <div className="flex shrink-0 gap-1 px-4 pb-3">
        {(
          [
            ["prompt", "Prompt"],
            ["memory", "记忆"],
            ["backup", "备份"],
            ["hearing", "听力"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex-1 min-h-11 rounded-md py-2 text-sm",
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
            onChange={(e) => setDraft(e.target.value)}
            maxLength={8000}
            className="min-h-0 flex-1 resize-none font-mono leading-relaxed"
            placeholder="写给模型的 system prompt"
          />
          <p className="mt-2 text-xs text-subtle">记忆会另外附上，不用写进这段。</p>
        </div>
      ) : tab === "backup" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <p className="text-sm leading-relaxed text-muted">
              导出一份文件，里面是 prompt、记忆和聊天。换域名、换手机时在新站导入。文件放在你自己手里，不要传到 GitHub。
            </p>
            <Button
              type="button"
              onClick={() => {
                const backup = makeBackup({ profile, memories, messages });
                const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = backupFilename(backup.exportedAt);
                link.click();
                URL.revokeObjectURL(url);
                setBackupStatus("已下载备份。");
              }}
            >
              导出备份
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                void file.text().then(async (text) => {
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(text);
                  } catch {
                    setBackupStatus("这不是一份能读的备份。");
                    return;
                  }
                  const backup = parseBackup(parsed);
                  if (!backup) {
                    setBackupStatus("文件不对，没有导入。");
                    return;
                  }
                  setBackupStatus("正在导入…");
                  try {
                    await onRestoreBackup(backup);
                    setBackupStatus(
                      `已导入。记忆 ${backup.memories.length} 条，对话 ${backup.messages.length} 条。`,
                    );
                  } catch {
                    setBackupStatus("导入失败，稍后再试。");
                  }
                });
              }}
            />
            <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
              导入备份
            </Button>
            {backupStatus ? <p className="text-sm text-subtle">{backupStatus}</p> : null}
            <LogoutButton />
          </div>
        </div>
      ) : tab === "hearing" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-5">
            <div>
              <p className="mb-2 text-sm">听力引擎</p>
              <p className="mb-3 text-xs text-subtle">默认 xAI 现有流程。Qwen / Gemini / 自部署会输出「字 + 语气 tag」，失败自动退回 xAI。</p>
              <div className="grid grid-cols-2 gap-2">
                {HEARING_PROVIDERS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setHearingProvider(id)}
                    className={cn(
                      "min-h-11 rounded-md px-3 py-3 text-sm",
                      hearingProvider === id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
                    )}
                  >
                    {PROVIDER_LABEL[id]}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-start gap-3 rounded-md bg-surface-2 px-3 py-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={debugHearing}
                onChange={(e) => setDebugHearing(e.target.checked)}
              />
              <span>
                <span className="block text-sm">调试模式</span>
                <span className="block text-xs text-subtle">默认开。关掉后不显示确认入口，也不存任何录音。</span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md bg-surface-2 px-3 py-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={hearingNbest}
                onChange={(e) => setHearingNbest(e.target.checked)}
              />
              <span>
                <span className="block text-sm">n-best 候选</span>
                <span className="block text-xs text-subtle">默认关。打开后不确定的词会写成 {"{A|B}"}。</span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md bg-surface-2 px-3 py-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={captureAudio}
                onChange={(e) => setCaptureAudio(e.target.checked)}
              />
              <span>
                <span className="block text-sm">录音采集</span>
                <span className="block text-xs text-subtle">默认关。打开后把每段 16kHz WAV 存到私有库，不含公开链接。</span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md bg-surface-2 px-3 py-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={scriptedCapture}
                onChange={(e) => setScriptedCapture(e.target.checked)}
              />
              <span>
                <span className="block text-sm">定向录制</span>
                <span className="block text-xs text-subtle">屏幕显示当前类别和剩余配额，录完自动打标签。</span>
              </span>
            </label>
            <Link
              to="/lab"
              className="flex h-11 items-center justify-center rounded-md bg-surface-2 text-sm"
              onClick={() => onOpenChange(false)}
            >
              打开标注页
            </Link>
            <p className="text-xs text-subtle">标注页有密码保护。密码是环境变量 HEARING_LAB_PASSWORD。</p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                commitNewMemory();
              }}
            >
              <Textarea
                value={newFact}
                onChange={(e) => {
                  const value = e.target.value;
                  setNewFact(value);
                  if (newTimeTouched) return;
                  const parsed = splitLeadingTimestamp(value);
                  if (parsed.at) setNewAt(toDatetimeLocal(parsed.at));
                }}
                placeholder="记下大事"
                maxLength={200}
                className="min-h-24 resize-none"
              />
              <div className="flex gap-2">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">记忆时间</span>
                  <Input
                    type="datetime-local"
                    value={newAt}
                    onChange={(e) => {
                      setNewTimeTouched(true);
                      setNewAt(e.target.value);
                    }}
                    className="flex-1"
                  />
                </label>
                <Button type="submit" size="pill" disabled={!newFact.trim()}>
                  记下
                </Button>
              </div>
              <p className="text-xs text-subtle">默认现在。开头写日期会自动填上。</p>
            </form>
            <Button
              type="button"
              variant="outline"
              disabled={memories.length < 2 || consolidating}
              onClick={() => {
                setConsolidating(true);
                void onConsolidateMemories().finally(() => setConsolidating(false));
              }}
            >
              {consolidating ? "正在整理…" : "把碎记忆收成关键事件"}
            </Button>
            {memories.length === 0 ? (
              <p className="text-sm text-subtle">还没有。只记会改往后相处的事。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {sortMemoriesByTime(memories, true).map((m) => (
                    <li key={m.id} className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
                      {editingId === m.id ? (
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                          <Input
                            autoFocus
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                          />
                          <Input
                            type="datetime-local"
                            value={editAt}
                            onChange={(e) => setEditAt(e.target.value)}
                          />
                        </div>
                      ) : (
                        <span className="flex-1 leading-relaxed">
                          <span className="mr-2 text-xs text-subtle">
                            {formatMemoryTime(m.createdAt)}
                          </span>
                          {m.text}
                        </span>
                      )}
                      {editingId === m.id ? (
                        <button
                          type="button"
                          aria-label="好"
                          onClick={() => {
                            const resolved = resolveManualMemory(editDraft, editAt, true);
                            onUpdateMemory(m.id, resolved.text, resolved.at);
                            setEditingId(null);
                          }}
                          className="mt-0.5 text-subtle hover:text-fg"
                        >
                          <Check className="size-4" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          aria-label="改"
                          onClick={() => {
                            setEditingId(m.id);
                            setEditDraft(m.text);
                            setEditAt(toDatetimeLocal(m.createdAt));
                          }}
                          className="mt-0.5 text-subtle hover:text-fg"
                        >
                          <Pencil className="size-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label="忘掉"
                        onClick={() => onDeleteMemory(m.id)}
                        className="mt-0.5 text-subtle hover:text-fg"
                      >
                        <X className="size-4" />
                      </button>
                    </li>
                  ))}
              </ul>
            )}
            <Button variant="outline" onClick={onClearChat}>
              清空对话
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatMemoryTime(ms: number) {
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

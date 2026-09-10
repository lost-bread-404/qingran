import { Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_SYSTEM_PROMPT, type Memory, type Profile } from "@/lib/lover/types";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile;
  memories: Memory[];
  onSave: (next: Profile) => void;
  onAddMemory: (text: string) => void;
  onUpdateMemory: (id: string, text: string) => void;
  onDeleteMemory: (id: string) => void;
  onConsolidateMemories: () => Promise<void>;
  onClearChat: () => void;
};

export function SettingsDrawer({
  open,
  onOpenChange,
  profile,
  memories,
  onSave,
  onAddMemory,
  onUpdateMemory,
  onDeleteMemory,
  onConsolidateMemories,
  onClearChat,
}: Props) {
  const [draft, setDraft] = useState(profile.systemPrompt);
  const [newFact, setNewFact] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [tab, setTab] = useState<"prompt" | "memory">("prompt");
  const [consolidating, setConsolidating] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(profile.systemPrompt);
      setTab("prompt");
    }
  }, [open, profile.systemPrompt]);

  function save() {
    onSave({
      ...profile,
      systemPrompt: draft.trim() || DEFAULT_SYSTEM_PROMPT,
    });
    onOpenChange(false);
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
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex-1 rounded-md py-2 text-sm",
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
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const text = newFact.trim();
                if (!text) return;
                onAddMemory(text);
                setNewFact("");
              }}
            >
              <Input
                value={newFact}
                onChange={(e) => setNewFact(e.target.value)}
                placeholder="记下大事"
                maxLength={120}
              />
              <Button type="submit" size="pill" disabled={!newFact.trim()}>
                记下
              </Button>
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
                {memories
                  .slice()
                  .reverse()
                  .map((m) => (
                    <li key={m.id} className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
                      {editingId === m.id ? (
                        <Input
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onBlur={() => {
                            if (editingId) onUpdateMemory(editingId, editDraft);
                            setEditingId(null);
                          }}
                          className="flex-1"
                        />
                      ) : (
                        <span className="flex-1 leading-relaxed">
                          <span className="mr-2 text-[11px] text-subtle">
                            {formatMemoryTime(m.createdAt)}
                          </span>
                          {m.text}
                        </span>
                      )}
                      {editingId === m.id ? null : (
                        <button
                          type="button"
                          aria-label="改"
                          onClick={() => {
                            setEditingId(m.id);
                            setEditDraft(m.text);
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

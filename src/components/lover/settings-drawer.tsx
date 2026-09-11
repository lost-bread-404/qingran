import { Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { MemoryBoard, MemoryItem } from "@/lib/lover/memory/types";
import { DEFAULT_SYSTEM_PROMPT, type Profile } from "@/lib/lover/types";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile;
  board: MemoryBoard;
  onSave: (next: Profile) => void;
  onAddMemory: (text: string) => void;
  onUpdateMemory: (item: MemoryItem, text: string) => void;
  onDeleteMemory: (item: MemoryItem) => void;
  onClearChat: () => void;
};

export function SettingsDrawer({
  open,
  onOpenChange,
  profile,
  board,
  onSave,
  onAddMemory,
  onUpdateMemory,
  onDeleteMemory,
  onClearChat,
}: Props) {
  const [draft, setDraft] = useState(profile.systemPrompt);
  const [newFact, setNewFact] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [tab, setTab] = useState<"prompt" | "memory">("prompt");

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

  const patterns = board.items.filter((item) => item.layer === "l3");
  const events = board.items.filter((item) => item.layer !== "l3");

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
          <p className="text-xs text-subtle">宪章在 Prompt。记忆由后台整理，不写进人设。</p>
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
            placeholder="写给模型的 system prompt（宪章）"
          />
          <p className="mt-2 text-xs text-subtle">这段是宪章，优先级最高。记忆系统不会改它。</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-5">
            <section className="flex flex-col gap-2">
              <p className="text-xs text-subtle">活画像</p>
              {board.portrait.trim() ? (
                <p className="whitespace-pre-wrap rounded-md bg-surface-2 px-3 py-2 text-sm leading-relaxed">
                  {board.portrait}
                </p>
              ) : (
                <p className="text-sm text-subtle">还没有。聊过一段时间后由后台整页重写，不追加。</p>
              )}
            </section>

            {board.openEvents.length > 0 ? (
              <section className="flex flex-col gap-2">
                <p className="text-xs text-subtle">未结束</p>
                {board.openEvents.map((item) => (
                  <p
                    key={item.id}
                    className="rounded-md bg-surface-2 px-3 py-2 text-sm leading-relaxed text-muted"
                  >
                    {item.text}
                  </p>
                ))}
              </section>
            ) : null}

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
                placeholder="记下已经结束的事"
                maxLength={200}
              />
              <Button type="submit" size="pill" disabled={!newFact.trim()}>
                记下
              </Button>
            </form>

            {patterns.length > 0 ? (
              <section className="flex flex-col gap-2">
                <p className="text-xs text-subtle">规律</p>
                <ul className="flex flex-col gap-2">
                  {patterns.map((item) => (
                    <MemoryRow
                      key={item.id}
                      item={item}
                      editing={editingId === item.id}
                      editDraft={editDraft}
                      onEditDraft={setEditDraft}
                      onEditStart={() => {
                        setEditingId(item.id);
                        setEditDraft(item.text);
                      }}
                      onEditEnd={() => {
                        if (editingId) onUpdateMemory(item, editDraft);
                        setEditingId(null);
                      }}
                      onDelete={() => onDeleteMemory(item)}
                    />
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="flex flex-col gap-2">
              <p className="text-xs text-subtle">已结束的事</p>
              {events.length === 0 ? (
                <p className="text-sm text-subtle">还没有入库的事件。未结束的事不会被切成一天一条。</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {events.map((item) => (
                    <MemoryRow
                      key={item.id}
                      item={item}
                      editing={editingId === item.id}
                      editDraft={editDraft}
                      onEditDraft={setEditDraft}
                      onEditStart={() => {
                        setEditingId(item.id);
                        setEditDraft(item.text);
                      }}
                      onEditEnd={() => {
                        if (editingId) onUpdateMemory(item, editDraft);
                        setEditingId(null);
                      }}
                      onDelete={() => onDeleteMemory(item)}
                    />
                  ))}
                </ul>
              )}
            </section>

            <Button variant="outline" onClick={onClearChat}>
              清空对话
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function MemoryRow({
  item,
  editing,
  editDraft,
  onEditDraft,
  onEditStart,
  onEditEnd,
  onDelete,
}: {
  item: MemoryItem;
  editing: boolean;
  editDraft: string;
  onEditDraft: (text: string) => void;
  onEditStart: () => void;
  onEditEnd: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
      {editing ? (
        <Input
          autoFocus
          value={editDraft}
          onChange={(e) => onEditDraft(e.target.value)}
          onBlur={onEditEnd}
          className="flex-1"
        />
      ) : (
        <span className="flex-1 leading-relaxed">
          <span className="mr-2 text-[11px] text-subtle">
            {item.layer === "l3"
              ? item.status === "dormant"
                ? "休眠"
                : "有效"
              : formatMemoryTime(item.startedAt)}
          </span>
          {item.text}
        </span>
      )}
      {editing ? null : (
        <button
          type="button"
          aria-label="改"
          onClick={onEditStart}
          className="mt-0.5 text-subtle hover:text-fg"
        >
          <Pencil className="size-4" />
        </button>
      )}
      <button
        type="button"
        aria-label="忘掉"
        onClick={onDelete}
        className="mt-0.5 text-subtle hover:text-fg"
      >
        <X className="size-4" />
      </button>
    </li>
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

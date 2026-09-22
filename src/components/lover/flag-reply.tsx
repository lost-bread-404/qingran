import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { keepCaretVisible, useVisualViewportHeight } from "@/hooks/use-visual-viewport";
import { REPLY_DOWN_TAGS, type ReplyDownTag } from "@/lib/lover/reply-feedback";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  triggerText?: string;
  replyText?: string;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (input: { note: string; tags: ReplyDownTag[] }) => Promise<void> | void;
};

export function FlagReply({ open, triggerText, replyText, busy, error, onClose, onSave }: Props) {
  const [note, setNote] = useState("");
  const [tags, setTags] = useState<ReplyDownTag[]>([]);
  const viewport = useVisualViewportHeight(open);

  useEffect(() => {
    if (!open) return;
    setNote("");
    setTags([]);
  }, [open]);

  if (!open) return null;

  function toggle(tag: ReplyDownTag) {
    setTags((cur) => (cur.includes(tag) ? cur.filter((item) => item !== tag) : [...cur, tag]));
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-bg/80">
      <button type="button" className="min-h-0 flex-1" aria-label="关掉" onClick={onClose} />
      <div
        className="rounded-t-2xl bg-bg px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-lamp"
        style={{ marginBottom: viewport.offsetTop ? 0 : undefined }}
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="font-display text-lg">差在哪</p>
          <button
            type="button"
            aria-label="关掉"
            onClick={onClose}
            className="grid size-11 place-items-center rounded-md text-muted"
          >
            <X className="size-5" />
          </button>
        </div>
        {triggerText ? <p className="text-xs text-subtle">你：{triggerText}</p> : null}
        {replyText ? <p className="mt-1 text-sm text-muted">清然：{replyText}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {REPLY_DOWN_TAGS.map((tag) => {
            const on = tags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(tag)}
                className={cn(
                  "min-h-11 rounded-md px-3 text-sm",
                  on ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
                )}
              >
                {tag}
              </button>
            );
          })}
        </div>
        <Input
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            keepCaretVisible(e.currentTarget);
          }}
          onSelect={(e) => keepCaretVisible(e.currentTarget)}
          className="mt-3"
          placeholder="一行备注，可选"
          aria-label="回复备注"
          maxLength={200}
        />
        {error ? <p className="mt-2 text-sm text-live">{error}</p> : null}
        <div className="mt-4 flex gap-2">
          <Button type="button" variant="outline" className="min-h-11 flex-1" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            className="min-h-11 flex-1"
            disabled={busy || (tags.length === 0 && !note.trim())}
            onClick={() => void onSave({ note: note.trim(), tags })}
          >
            {busy ? "正在写入…" : "记下"}
          </Button>
        </div>
      </div>
    </div>
  );
}

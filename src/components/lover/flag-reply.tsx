import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  triggerText?: string;
  replyText?: string;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (note: string) => Promise<void> | void;
};

export function FlagReply({ open, triggerText, replyText, busy, error, onClose, onSave }: Props) {
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    setNote("");
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-bg/80">
      <button type="button" className="min-h-0 flex-1" aria-label="关掉" onClick={onClose} />
      <div className="rounded-t-2xl bg-bg px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-lamp">
        <div className="mb-3 flex items-center justify-between">
          <p className="font-display text-lg">这条回复不好</p>
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
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="mt-3"
          placeholder="一行备注，可选"
          aria-label="回复备注"
          maxLength={200}
        />
        {error ? <p className="mt-2 text-sm text-live">{error}</p> : null}
        <div className="mt-4">
          <Button type="button" className="w-full" disabled={busy} onClick={() => void onSave(note.trim())}>
            {busy ? "正在写入…" : "记下"}
          </Button>
        </div>
      </div>
    </div>
  );
}
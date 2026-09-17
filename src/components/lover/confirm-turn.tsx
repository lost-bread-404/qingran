import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EMOTIONS, type CueEmotion } from "@/lib/lover/hearing/schema";
import { cn } from "@/lib/utils";

const EMOTION_LABEL: Record<CueEmotion, string> = {
  coy: "撒娇",
  playful: "玩",
  content: "满足",
  sleepy: "困",
  sad: "委屈",
  annoyed: "烦",
  neutral: "平",
};

type Props = {
  open: boolean;
  sttText: string;
  onClose: () => void;
  onConfirm: (goldText: string, source: "confirmed" | "edited", emotion: CueEmotion | null) => void;
  busy?: boolean;
  initialEmotion?: CueEmotion | null;
};

export function ConfirmTurn({ open, sttText, onClose, onConfirm, busy, initialEmotion = null }: Props) {
  const [draft, setDraft] = useState(sttText);
  const [emotion, setEmotion] = useState<CueEmotion | null>(initialEmotion);

  useEffect(() => {
    if (!open) return;
    setDraft(sttText);
    setEmotion(initialEmotion);
  }, [open, sttText, initialEmotion]);

  if (!open) return null;

  const edited = draft.trim() !== sttText.trim();

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-bg/70">
      <button type="button" className="min-h-0 flex-1" aria-label="关掉" onClick={onClose} />
      <div className="rounded-t-2xl bg-bg px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-lamp">
        <div className="mb-3 flex items-center justify-between">
          <p className="font-display text-lg">确认这句话</p>
          <button
            type="button"
            aria-label="关掉"
            onClick={onClose}
            className="grid size-11 place-items-center rounded-md text-muted"
          >
            <X className="size-5" />
          </button>
        </div>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-28"
          aria-label="识别文本"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {EMOTIONS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setEmotion((cur) => (cur === id ? null : id))}
              className={cn(
                "min-h-11 rounded-md px-3 text-sm",
                emotion === id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
              )}
            >
              {EMOTION_LABEL[id]}
            </button>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            disabled={busy || edited}
            onClick={() => onConfirm(sttText, "confirmed", emotion)}
          >
            确认正确
          </Button>
          <Button
            type="button"
            className="flex-1"
            disabled={busy || !draft.trim() || !edited}
            onClick={() => onConfirm(draft.trim(), "edited", emotion)}
          >
            保存修改
          </Button>
        </div>
      </div>
    </div>
  );
}

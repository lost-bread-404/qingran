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

const CHIPS: { id: CueEmotion | "noise"; label: string }[] = [
  ...EMOTIONS.map((id) => ({ id, label: EMOTION_LABEL[id] })),
  { id: "noise", label: "噪音" },
];

type Props = {
  open: boolean;
  sttText: string;
  audioUrl?: string | null;
  onClose: () => void;
  onConfirm: (
    goldText: string,
    source: "confirmed" | "edited",
    emotion: CueEmotion | null,
    noiseOnly: boolean,
  ) => Promise<void> | void;
  busy?: boolean;
  error?: string | null;
  initialEmotion?: CueEmotion | null;
  initialNoise?: boolean;
};

export function ConfirmTurn({
  open,
  sttText,
  audioUrl,
  onClose,
  onConfirm,
  busy,
  error,
  initialEmotion = null,
  initialNoise = false,
}: Props) {
  const [draft, setDraft] = useState(sttText);
  const [emotion, setEmotion] = useState<CueEmotion | null>(initialEmotion);
  const [noiseOnly, setNoiseOnly] = useState(initialNoise);

  useEffect(() => {
    if (!open) return;
    setDraft(sttText);
    setEmotion(initialEmotion);
    setNoiseOnly(initialNoise);
  }, [open, sttText, initialEmotion, initialNoise]);

  if (!open) return null;

  const edited = draft.trim() !== sttText.trim();
  const selected: CueEmotion | "noise" | null = noiseOnly ? "noise" : emotion;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-bg/80">
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
        {audioUrl ? (
          <audio className="mb-3 w-full" controls src={audioUrl} />
        ) : (
          <p className="mb-3 text-xs text-subtle">没有这段录音，或者还在加载。</p>
        )}
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-28"
          aria-label="识别文字"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => {
                const id = chip.id;
                if (id === "noise") {
                  setNoiseOnly((cur) => !cur);
                  setEmotion(null);
                  return;
                }
                setNoiseOnly(false);
                setEmotion((cur) => (cur === id ? null : id));
              }}
              className={cn(
                "min-h-11 rounded-md px-3 text-sm",
                selected === chip.id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
        {error ? <p className="mt-2 text-sm text-live">{error}</p> : null}
        <div className="mt-4">
          <Button
            type="button"
            className="w-full"
            disabled={busy}
            onClick={() =>
              void onConfirm(draft.trim(), edited ? "edited" : "confirmed", emotion, noiseOnly)
            }
          >
            {busy ? "正在写入…" : "确认"}
          </Button>
        </div>
      </div>
    </div>
  );
}

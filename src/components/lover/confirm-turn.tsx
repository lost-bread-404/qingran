import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  sttText: string;
  audioUrl?: string | null;
  onClose: () => void;
  onConfirm: (input: {
    goldText: string;
    source: "confirmed" | "edited";
    noiseOnly: boolean;
    literalMismatch: boolean;
    toneNote: string;
  }) => Promise<void> | void;
  busy?: boolean;
  error?: string | null;
  initialNoise?: boolean;
  initialLiteralMismatch?: boolean;
  initialToneNote?: string | null;
};

export function ConfirmTurn({
  open,
  sttText,
  audioUrl,
  onClose,
  onConfirm,
  busy,
  error,
  initialNoise = false,
  initialLiteralMismatch = false,
  initialToneNote = "",
}: Props) {
  const [draft, setDraft] = useState(sttText);
  const [noiseOnly, setNoiseOnly] = useState(initialNoise);
  const [literalMismatch, setLiteralMismatch] = useState(initialLiteralMismatch);
  const [toneNote, setToneNote] = useState(initialToneNote ?? "");

  useEffect(() => {
    if (!open) return;
    setDraft(sttText);
    setNoiseOnly(initialNoise);
    setLiteralMismatch(initialLiteralMismatch);
    setToneNote(initialToneNote ?? "");
  }, [open, sttText, initialNoise, initialLiteralMismatch, initialToneNote]);

  if (!open) return null;

  const edited = draft.trim() !== sttText.trim();

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
          <button
            type="button"
            aria-pressed={noiseOnly}
            onClick={() => setNoiseOnly((cur) => !cur)}
            className={cn(
              "min-h-11 rounded-md px-3 text-sm",
              noiseOnly ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
            )}
          >
            噪音
          </button>
          <button
            type="button"
            aria-pressed={literalMismatch}
            onClick={() => setLiteralMismatch((cur) => !cur)}
            className={cn(
              "min-h-11 rounded-md px-3 text-sm",
              literalMismatch ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
            )}
          >
            字面≠意思
          </button>
        </div>
        <p className="mt-2 text-xs text-subtle">反话、玩笑、嘴上说讨厌其实在撒娇。</p>
        <Input
          value={toneNote}
          onChange={(e) => setToneNote(e.target.value)}
          className="mt-2"
          placeholder="可选备注"
          aria-label="语气备注"
          maxLength={80}
        />
        {error ? <p className="mt-2 text-sm text-live">{error}</p> : null}
        <div className="mt-4">
          <Button
            type="button"
            className="w-full"
            disabled={busy}
            onClick={() =>
              void onConfirm({
                goldText: draft.trim(),
                source: edited ? "edited" : "confirmed",
                noiseOnly,
                literalMismatch,
                toneNote: toneNote.trim(),
              })
            }
          >
            {busy ? "正在写入…" : "确认"}
          </Button>
        </div>
      </div>
    </div>
  );
}

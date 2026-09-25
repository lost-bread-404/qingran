import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { keepCaretVisible, useVisualViewportHeight } from "@/hooks/use-visual-viewport";
import { goldTextForSave, confirmNoiseOnly } from "@/lib/lover/hearing/confirm-resend";
import { cn } from "@/lib/utils";
import type { AcousticTags, TagKey } from "@/lib/lover/hearing/tags";

type Props = {
  open: boolean;
  sttText: string;
  audioUrl?: string | null;
  clipNote?: string | null;
  onClose: () => void;
  onConfirm: (input: {
    goldText: string;
    source: "confirmed" | "edited";
    noiseOnly: boolean;
    literalMismatch: boolean;
    toneNote: string;
    goldTags: Partial<AcousticTags>;
    tagsTouched: TagKey[];
  }) => Promise<void> | void;
  busy?: boolean;
  error?: string | null;
  initialNoise?: boolean;
  initialLiteralMismatch?: boolean;
  initialToneNote?: string | null;
  initialDraft?: string;
  initialPredicted?: AcousticTags | null;
  initialGoldTags?: Partial<AcousticTags> | null;
};

function caretOf(el: HTMLTextAreaElement | HTMLInputElement) {
  keepCaretVisible(el);
}

export function ConfirmTurn({
  open,
  sttText,
  audioUrl,
  clipNote,
  onClose,
  onConfirm,
  busy,
  error,
  initialNoise = false,
  initialToneNote = "",
  initialDraft,
}: Props) {
  const [draft, setDraft] = useState(initialDraft ?? sttText);
  const [noiseOnly, setNoiseOnly] = useState(initialNoise);
  const [toneNote, setToneNote] = useState(initialToneNote ?? "");
  const viewport = useVisualViewportHeight(open);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft ?? sttText);
    setNoiseOnly(initialNoise);
    setToneNote(initialToneNote ?? "");
  }, [open, sttText, initialDraft, initialNoise, initialToneNote]);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
      keepCaretVisible(active);
    }
  }, [open, viewport.height, viewport.offsetTop]);

  if (!open) return null;

  const goldText = goldTextForSave(draft);
  const nextNoise = confirmNoiseOnly({
    goldText: draft,
    noiseOnly,
  });

  return (
    <div
      className="fixed inset-x-0 z-50 flex flex-col bg-bg/80"
      style={{ top: viewport.offsetTop, height: viewport.height }}
    >
      {viewport.keyboardUp ? null : (
        <button type="button" className="min-h-0 flex-1" aria-label="关掉" onClick={onClose} />
      )}
      <div
        className={cn(
          "flex min-h-0 flex-col overflow-hidden rounded-t-2xl bg-bg px-4 pt-3 shadow-lamp",
          viewport.keyboardUp ? "flex-1" : "max-h-full",
        )}
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mb-3 flex shrink-0 items-center justify-between">
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
          <audio className="mb-3 w-full shrink-0" controls src={audioUrl} />
        ) : (
          <p className="mb-3 shrink-0 text-xs text-subtle">{clipNote || "没有这段录音，或者还在加载。"}</p>
        )}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <Textarea
            ref={draftRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              caretOf(e.currentTarget);
            }}
            onSelect={(e) => caretOf(e.currentTarget)}
            onFocus={(e) => {
              const box = e.currentTarget;
              const scroller = scrollRef.current;
              if (scroller) scroller.scrollTop = Math.max(0, box.offsetTop - 8);
              window.setTimeout(() => {
                window.scrollTo(0, 0);
                caretOf(box);
              }, 50);
            }}
            className="min-h-28"
            aria-label="识别文字"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={nextNoise}
              onClick={() => setNoiseOnly((cur) => !cur)}
              className={cn(
                "min-h-11 rounded-md px-3 text-sm",
                nextNoise ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
              )}
            >
              噪音
            </button>
          </div>
          <Input
            value={toneNote}
            onChange={(e) => {
              setToneNote(e.target.value);
              caretOf(e.currentTarget);
            }}
            onSelect={(e) => caretOf(e.currentTarget)}
            onFocus={(e) => {
              const box = e.currentTarget;
              window.setTimeout(() => {
                window.scrollTo(0, 0);
                caretOf(box);
              }, 50);
            }}
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
              onClick={() => {
                void onConfirm({
                  goldText,
                  source: !goldText || goldText !== sttText.trim() ? "edited" : "confirmed",
                  noiseOnly: nextNoise,
                  literalMismatch: false,
                  toneNote: toneNote.trim(),
                  goldTags: {},
                  tagsTouched: [],
                });
              }}
            >
              {busy ? "正在写入…" : "确认"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

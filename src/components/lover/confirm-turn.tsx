import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { keepCaretVisible, useVisualViewportHeight } from "@/hooks/use-visual-viewport";
import { cn } from "@/lib/utils";
import {
  EVENT_CHIP_LABELS,
  EVENT_CHIP_VALUES,
  TAG_CONTOURS,
  TAG_KEYS,
  TAG_LABELS,
  TAG_LENGTHS,
  TAG_VALUE_LABELS,
  TAG_VOICES,
  goldTagsFromTouched,
  parsePartialAcousticTags,
  tagsTouched,
  toggleEventChip,
  type AcousticTags,
  type TagKey,
} from "@/lib/lover/hearing/tags";

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

const OPTIONS: Record<"length" | "contour" | "voice", readonly string[]> = {
  length: TAG_LENGTHS,
  contour: TAG_CONTOURS,
  voice: TAG_VOICES,
};

function mergeChosen(predicted: AcousticTags, gold?: Partial<AcousticTags> | null): AcousticTags {
  const parsed = parsePartialAcousticTags(gold) ?? {};
  return {
    length: parsed.length ?? predicted.length,
    contour: parsed.contour ?? predicted.contour,
    voice: parsed.voice ?? predicted.voice,
    events: parsed.events ?? predicted.events,
  };
}

function caretOf(el: HTMLTextAreaElement | HTMLInputElement) {
  keepCaretVisible(el);
}

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
  initialDraft,
  initialPredicted,
  initialGoldTags,
}: Props) {
  const predicted = initialPredicted ?? {};
  const [draft, setDraft] = useState(initialDraft ?? sttText);
  const [noiseOnly, setNoiseOnly] = useState(initialNoise);
  const [literalMismatch, setLiteralMismatch] = useState(initialLiteralMismatch);
  const [toneNote, setToneNote] = useState(initialToneNote ?? "");
  const [chosen, setChosen] = useState<AcousticTags>(() => mergeChosen(predicted, initialGoldTags));
  const viewport = useVisualViewportHeight(open);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const nextPredicted = initialPredicted ?? {};
    setDraft(initialDraft ?? sttText);
    setNoiseOnly(initialNoise);
    setLiteralMismatch(initialLiteralMismatch);
    setToneNote(initialToneNote ?? "");
    setChosen(mergeChosen(nextPredicted, initialGoldTags));
  }, [open, sttText, initialDraft, initialNoise, initialLiteralMismatch, initialToneNote, initialPredicted, initialGoldTags]);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
      keepCaretVisible(active);
    }
  }, [open, viewport.height, viewport.offsetTop]);

  if (!open) return null;

  const edited = draft.trim() !== sttText.trim();

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
          <p className="mb-3 shrink-0 text-xs text-subtle">没有这段录音，或者还在加载。</p>
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
          <div className="mt-3 flex flex-col gap-3">
            {TAG_KEYS.map((key) => (
              <div key={key}>
                <p className="mb-1 text-xs text-subtle">
                  {TAG_LABELS[key]}
                  {key === "events"
                    ? chosen.events === undefined
                      ? " · 未预测"
                      : ""
                    : chosen[key] == null
                      ? " · 未预测"
                      : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  {key === "events"
                    ? EVENT_CHIP_VALUES.map((value) => {
                        const selected =
                          value === "none"
                            ? Array.isArray(chosen.events) && chosen.events.length === 0
                            : Boolean(chosen.events?.includes(value));
                        return (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={selected}
                            onClick={() =>
                              setChosen((cur) => ({ ...cur, events: toggleEventChip(cur.events ?? [], value) }))
                            }
                            className={cn(
                              "min-h-11 rounded-md px-3 text-sm",
                              selected ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
                            )}
                          >
                            {EVENT_CHIP_LABELS[value]}
                          </button>
                        );
                      })
                    : OPTIONS[key].map((value) => {
                        const selected = chosen[key] === value;
                        const label = TAG_VALUE_LABELS[key][value as never] as string;
                        return (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setChosen((cur) => ({ ...cur, [key]: value }))}
                            className={cn(
                              "min-h-11 rounded-md px-3 text-sm",
                              selected ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
                            )}
                          >
                            {label}
                          </button>
                        );
                      })}
                </div>
              </div>
            ))}
          </div>
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
                const nextPredicted = initialPredicted ?? {};
                const touched = tagsTouched(nextPredicted, chosen);
                void onConfirm({
                  goldText: draft.trim(),
                  source: edited ? "edited" : "confirmed",
                  noiseOnly,
                  literalMismatch,
                  toneNote: toneNote.trim(),
                  goldTags: goldTagsFromTouched(chosen, touched),
                  tagsTouched: touched,
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

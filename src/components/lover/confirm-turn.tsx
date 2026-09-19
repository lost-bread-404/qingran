import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  TAG_CONTOURS,
  TAG_EVENTS,
  TAG_KEYS,
  TAG_LABELS,
  TAG_LENGTHS,
  TAG_VALUE_LABELS,
  TAG_VOICES,
  defaultTags,
  goldTagsFromTouched,
  tagsTouched,
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

const OPTIONS: Record<TagKey, readonly string[]> = {
  length: TAG_LENGTHS,
  contour: TAG_CONTOURS,
  voice: TAG_VOICES,
  event: TAG_EVENTS,
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
  initialDraft,
  initialPredicted,
  initialGoldTags,
}: Props) {
  const predicted = initialPredicted ?? defaultTags();
  const [draft, setDraft] = useState(initialDraft ?? sttText);
  const [noiseOnly, setNoiseOnly] = useState(initialNoise);
  const [literalMismatch, setLiteralMismatch] = useState(initialLiteralMismatch);
  const [toneNote, setToneNote] = useState(initialToneNote ?? "");
  const [chosen, setChosen] = useState<AcousticTags>({ ...predicted, ...initialGoldTags });

  useEffect(() => {
    if (!open) return;
    const nextPredicted = initialPredicted ?? defaultTags();
    setDraft(initialDraft ?? sttText);
    setNoiseOnly(initialNoise);
    setLiteralMismatch(initialLiteralMismatch);
    setToneNote(initialToneNote ?? "");
    setChosen({ ...nextPredicted, ...initialGoldTags });
  }, [open, sttText, initialDraft, initialNoise, initialLiteralMismatch, initialToneNote, initialPredicted, initialGoldTags]);

  if (!open) return null;

  const edited = draft.trim() !== sttText.trim();

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-bg/80">
      <button type="button" className="min-h-0 flex-1" aria-label="关掉" onClick={onClose} />
      <div className="max-h-[90dvh] overflow-y-auto rounded-t-2xl bg-bg px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-lamp">
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
        <div className="mt-3 flex flex-col gap-3">
          {TAG_KEYS.map((key) => (
            <div key={key}>
              <p className="mb-1 text-xs text-subtle">{TAG_LABELS[key]}</p>
              <div className="flex flex-wrap gap-2">
                {OPTIONS[key].map((value) => {
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
            onClick={() => {
              const nextPredicted = initialPredicted ?? defaultTags();
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
  );
}
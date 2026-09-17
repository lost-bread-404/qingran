import { ChevronDown, Pencil, Volume2 } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { pairMessages } from "@/lib/lover/pair-messages";
import type { ChatMessage } from "@/lib/lover/types";

const PIN_PX = 96;
const PAGE_UP_SCREENS = 3;

export type TranscriptHandle = {
  pageUp: () => void;
};

type Props = {
  messages: ChatMessage[];
  partnerName: string;
  statusLine: string;
  thinking?: boolean;
  keyboardPad?: number;
  editableId?: string | null;
  editingId?: string | null;
  editDraft?: string;
  onPlay?: (id: string, text: string) => void;
  onEditStart?: (id: string) => void;
  onEditDraft?: (text: string) => void;
  onEditCancel?: () => void;
  onEditSave?: () => void;
};

function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < PIN_PX;
}

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

export const Transcript = forwardRef<TranscriptHandle, Props>(function Transcript(
  {
    messages,
    partnerName,
    statusLine,
    thinking,
    keyboardPad = 0,
    editableId,
    editingId,
    editDraft,
    onPlay,
    onEditStart,
    onEditDraft,
    onEditCancel,
    onEditSave,
  },
  ref,
) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const pinRef = useRef(true);
  const [away, setAway] = useState(false);

  const jumpToBottom = () => {
    const el = scrollerRef.current;
    if (!el) return;
    pinRef.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
  };

  const pageUp = () => {
    const el = scrollerRef.current;
    if (!el || el.scrollTop <= 0) return;
    pinRef.current = false;
    setAway(true);
    const step = Math.max(el.clientHeight * PAGE_UP_SCREENS, 1);
    el.scrollTo({ top: Math.max(0, el.scrollTop - step), behavior: scrollBehavior() });
  };

  useImperativeHandle(ref, () => ({ pageUp }), []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !pinRef.current || editingId) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, thinking, editingId]);

  useEffect(() => {
    if (!editingId) return;
    const box = editorRef.current;
    const scroller = scrollerRef.current;
    if (!box) return;
    const place = () => {
      const len = box.value.length;
      box.focus({ preventScroll: true });
      box.setSelectionRange(len, len);
      const vv = window.visualViewport;
      const rect = box.getBoundingClientRect();
      const floor = vv ? vv.offsetTop + vv.height - 24 : window.innerHeight - 24;
      if (rect.bottom > floor && scroller) {
        scroller.scrollTop += rect.bottom - floor;
      }
    };
    window.setTimeout(place, 30);
    window.setTimeout(place, 280);
  }, [editingId]);

  if (messages.length === 0 && !thinking && !statusLine) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
        <p className="font-display text-4xl font-medium tracking-tight text-fg">
          {partnerName}
        </p>
        <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted">
          按住下面的按钮说话，或点电话。
        </p>
      </div>
    );
  }

  const pairs = pairMessages(messages);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div
      ref={scrollerRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [touch-action:pan-y]"
      style={{ paddingBottom: Math.max(16, keyboardPad + (editingId ? 12 : 0)) }}
      onScroll={(e) => {
        const el = e.currentTarget;
        const pinned = nearBottom(el);
        pinRef.current = pinned;
        setAway(!pinned);
      }}
    >
      <div className="flex min-h-full w-full flex-col justify-end gap-8">
        {pairs.map((pair, index) => (
          <div
            key={pair.note?.id ?? pair.user?.id ?? pair.assistant?.id ?? index}
            className="flex flex-col gap-3"
          >
            {pair.note ? (
              <p className="self-end whitespace-pre-wrap text-xs text-subtle">
                {pair.note.kind === "steer" ? "走向" : "设定"} · {pair.note.text}
              </p>
            ) : null}
            {pair.user ? (
              editingId === pair.user.id ? (
                <div className="flex w-full flex-col items-end gap-2">
                  <Textarea
                    ref={editorRef}
                    autoFocus
                    enterKeyHint="done"
                    value={editDraft ?? pair.user.text}
                    onChange={(e) => onEditDraft?.(e.target.value)}
                    className="min-h-28 w-full text-left"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="text-xs text-muted underline-offset-4 hover:underline"
                      onClick={onEditCancel}
                    >
                      取消
                    </button>
                    <Button type="button" size="pill" onClick={onEditSave}>
                      重说
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-end justify-end gap-2">
                  {editableId === pair.user.id && onEditStart ? (
                    <button
                      type="button"
                      aria-label="改这句话"
                      onClick={() => onEditStart(pair.user!.id)}
                      className="mb-1 shrink-0 text-subtle transition-colors duration-150 hover:text-fg"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  ) : null}
                  <p className="max-w-[min(20rem,85%)] whitespace-pre-wrap break-words rounded-2xl bg-surface-2 px-3.5 py-2 text-sm leading-relaxed text-fg">
                    {pair.user.text}
                  </p>
                </div>
              )
            ) : null}
            {pair.assistant?.text.trim() ? (
              <div className="flex max-w-[min(22rem,92%)] items-start gap-2 self-start">
                <p className="whitespace-pre-wrap break-words font-display text-lg font-medium leading-relaxed tracking-tight text-fg">
                  {pair.assistant.text}
                </p>
                {onPlay ? (
                  <button
                    type="button"
                    aria-label="播放这句话"
                    onClick={() => onPlay(pair.assistant!.id, pair.assistant!.text)}
                    className="mt-1 shrink-0 text-subtle transition-colors duration-150 hover:text-fg"
                  >
                    <Volume2 className="size-4" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {thinking ? (
          <div className="self-start h-1.5 w-10 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full w-full animate-pulse rounded-full bg-accent/70" />
          </div>
        ) : null}
        {statusLine ? (
          <p className="self-start whitespace-pre-wrap text-sm text-muted">{statusLine}</p>
        ) : null}
      </div>
    </div>
    {away ? (
      <button
        type="button"
        aria-label="回到最新"
        onClick={jumpToBottom}
        className="absolute bottom-3 left-1/2 z-10 flex size-11 -translate-x-1/2 items-center justify-center rounded-full bg-surface-2 text-subtle shadow-lamp transition-colors duration-150 hover:text-fg"
      >
        <ChevronDown className="size-4" />
      </button>
    ) : null}
    </div>
  );
});

import { stripSpeechTags } from "@/lib/lover/speech-tags";
import { ChevronDown, ChevronLeft, ChevronRight, Pencil, ThumbsDown, ThumbsUp, Volume2 } from "lucide-react";
import { photoSrc } from "@/lib/lover/photo-client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { stripSoundTags } from "@/lib/lover/message-meta";
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
  /** What she is saying right now (held, or in a call), shown as her line in the making; null: nothing. */
  liveLine?: string | null;
  editingId?: string | null;
  editDraft?: string;
  onPlay?: (id: string, text: string) => void;
  onEditStart?: (id: string) => void;
  onEditDraft?: (text: string) => void;
  onEditCancel?: () => void;
  onEditSave?: () => void;
  onPraiseReply?: (assistantId: string, replyToId?: string) => void;
  /** Her thumbs-down: opens 差在哪 (tags and a note) for this reply. */
  onFaultReply?: (assistantId: string, replyToId?: string) => void;
  praisedIds?: ReadonlySet<string>;
  onSelectReply?: (userId: string, replyId: string) => void;
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
    liveLine = null,
    editingId,
    editDraft,
    onPlay,
    onEditStart,
    onEditDraft,
    onEditCancel,
    onEditSave,
    onPraiseReply,
    onFaultReply,
    praisedIds,
    onSelectReply,
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

  /** A photo finished loading and made the talk taller: stay at the bottom if she was there. */
  const followIfPinned = () => {
    const el = scrollerRef.current;
    if (el && pinRef.current && !editingId) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !pinRef.current || editingId) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, thinking, editingId, liveLine]);

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

  if (messages.length === 0 && !thinking && !statusLine && liveLine == null) {
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
  // His messages that came on their own after her last word stay marked until she says something.
  const lastUserAt = messages.reduce((max: number, m: ChatMessage) => (m.role === "user" ? Math.max(max, m.createdAt) : max), 0);

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
              <p className="self-center px-6 text-center text-xs text-subtle">{pair.note.text}</p>
            ) : null}
            {pair.user ? (
              editingId === pair.user.id ? (
                <div className="flex w-full flex-col items-end gap-2">
                  <Textarea
                    ref={editorRef}
                    autoFocus
                    enterKeyHint="done"
                    value={editDraft ?? stripSoundTags(pair.user.text)}
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
                <UserBubble user={pair.user} onEditStart={onEditStart} onPhotoLoad={followIfPinned} />
              )
            ) : null}
            {(() => {
              const replies = pair.replies ?? (pair.assistant ? [pair.assistant] : []);
              const shown = pair.assistant;
              if (!shown || (!shown.text.trim() && replies.length < 2)) return null;
              const page = Math.max(0, replies.findIndex((reply) => reply.id === shown.id));
              return (
              <div className="flex max-w-[min(22rem,92%)] flex-col gap-6 self-start">
                {editingId === shown.id ? (
                  <div className="flex w-[min(22rem,92vw)] flex-col items-end gap-2">
                    <Textarea
                      ref={editorRef}
                      autoFocus
                      value={editDraft ?? shown.text}
                      onChange={(e) => onEditDraft?.(e.target.value)}
                      className="min-h-40 w-full text-left"
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
                        保存
                      </Button>
                    </div>
                  </div>
                ) : shown.text.trim() ? (
                <div className="flex items-start gap-2">
                  {!shown.replyTo && shown.createdAt > lastUserAt ? (
                    <span aria-label="还没回" className="mt-3 size-2 shrink-0 rounded-full bg-live" />
                  ) : null}
                  <div className="min-w-0">
                    <p className="whitespace-pre-wrap break-words font-display text-lg font-medium leading-relaxed tracking-tight text-fg">
                      {stripSpeechTags(shown.text)}
                    </p>
                  </div>
                  {onPlay ? (
                    <button
                      type="button"
                      aria-label="播放这句话"
                      onClick={() => onPlay(shown.id, shown.text)}
                      className="grid size-11 shrink-0 place-items-center text-subtle transition-colors duration-150 hover:text-fg"
                    >
                      <Volume2 className="size-4" />
                    </button>
                  ) : null}
                  {onEditStart ? (
                    <button
                      type="button"
                      aria-label="改他这句话"
                      onClick={() => onEditStart(shown.id)}
                      className="-ml-3 grid size-11 shrink-0 place-items-center text-subtle transition-colors duration-150 hover:text-fg"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                ) : null}
                {replies.length > 1 && pair.user ? (
                  <div className="flex items-center gap-2 text-sm text-subtle">
                    <button
                      type="button"
                      aria-label="上一条回复"
                      disabled={page <= 0}
                      onClick={() => onSelectReply?.(pair.user!.id, replies[page - 1]!.id)}
                      className="grid size-11 place-items-center disabled:opacity-30"
                    >
                      <ChevronLeft className="size-4" />
                    </button>
                    <span className="tabular-nums">
                      {page + 1} / {replies.length}
                    </span>
                    <button
                      type="button"
                      aria-label="下一条回复"
                      disabled={page >= replies.length - 1}
                      onClick={() => onSelectReply?.(pair.user!.id, replies[page + 1]!.id)}
                      className="grid size-11 place-items-center disabled:opacity-30"
                    >
                      <ChevronRight className="size-4" />
                    </button>
                  </div>
                ) : null}
                {onPraiseReply && shown.text.trim() ? (
                  <div className="relative z-10 flex items-center self-start">
                    <button
                      type="button"
                      aria-label="这条回复好"
                      aria-pressed={praisedIds?.has(shown.id) ?? false}
                      onClick={() => onPraiseReply(shown.id, pair.user?.id ?? shown.replyTo)}
                      className={
                        praisedIds?.has(shown.id)
                          ? "grid size-11 place-items-center text-fg [touch-action:manipulation]"
                          : "grid size-11 place-items-center text-subtle transition-colors duration-150 hover:text-fg [touch-action:manipulation]"
                      }
                    >
                      <ThumbsUp className={praisedIds?.has(shown.id) ? "size-4 fill-current" : "size-4"} />
                    </button>
                    {onFaultReply ? (
                      <button
                        type="button"
                        aria-label="这条回复不好"
                        onClick={() => onFaultReply(shown.id, pair.user?.id ?? shown.replyTo)}
                        className="grid size-11 place-items-center text-subtle transition-colors duration-150 hover:text-fg [touch-action:manipulation]"
                      >
                        <ThumbsDown className="size-4" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              );
            })()}
          </div>
        ))}
        {liveLine != null ? (
          <p
            aria-live="polite"
            className="max-w-[min(20rem,85%)] self-end whitespace-pre-wrap break-words rounded-2xl border border-dashed border-subtle/40 px-3.5 py-2 text-sm leading-relaxed text-muted"
          >
            {liveLine || "…"}
          </p>
        ) : null}
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

function UserBubble({
  user,
  onEditStart,
  onPhotoLoad,
}: {
  user: ChatMessage;
  onEditStart?: (id: string) => void;
  onPhotoLoad?: () => void;
}) {
  const text = stripSoundTags(user.text);
  return (
    <div className="flex items-end justify-end gap-2">
      {onEditStart ? (
        <button
          type="button"
          aria-label="改这句话"
          onClick={() => onEditStart(user.id)}
          className="mb-1 shrink-0 text-subtle transition-colors duration-150 hover:text-fg"
        >
          <Pencil className="size-3.5" />
        </button>
      ) : null}
      <div className="flex max-w-[min(20rem,85%)] flex-col items-end">
        {user.images?.length ? (
          <div className="mb-1 flex flex-wrap justify-end gap-1.5">
            {user.images.map((id) => (
              <img
                key={id}
                src={photoSrc(id)}
                alt="照片"
                onLoad={onPhotoLoad}
                className="max-h-60 max-w-full rounded-2xl object-cover"
              />
            ))}
          </div>
        ) : null}
        {text.trim() ? (
          <p className="whitespace-pre-wrap break-words rounded-2xl bg-surface-2 px-3.5 py-2 text-sm leading-relaxed text-fg">
            {text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

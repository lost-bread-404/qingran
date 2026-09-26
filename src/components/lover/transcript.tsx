import { Check, ChevronDown, ChevronLeft, ChevronRight, Pencil, ThumbsUp, Volume2 } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { pairMessages } from "@/lib/lover/pair-messages";
import { stripAcousticTags } from "@/lib/lover/hearing/tags";
import { formatTalkTrace } from "@/lib/lover/talk-fail";
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
  debugHearing?: boolean;
  onPlay?: (id: string, text: string) => void;
  onEditStart?: (id: string) => void;
  onEditDraft?: (text: string) => void;
  onEditCancel?: () => void;
  onEditSave?: () => void;
  onConfirmStart?: (id: string) => void;
  onConfirmQuick?: (id: string) => void;
  onUndoConfirm?: (id: string) => void;
  undoConfirmId?: string | null;
  onFlagReply?: (assistantId: string, replyToId?: string, rating?: "up" | "down") => void;
  praisedIds?: ReadonlySet<string>;
  onSelectReply?: (userId: string, replyId: string) => void;
  onNoiseReply?: (id: string) => void;
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
    debugHearing,
    onPlay,
    onEditStart,
    onEditDraft,
    onEditCancel,
    onEditSave,
    onConfirmStart,
    onConfirmQuick,
    onUndoConfirm,
    undoConfirmId,
    onFlagReply,
    praisedIds,
    onSelectReply,
    onNoiseReply,
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
              pair.note.kind === "system_notice" ? (
                <p className="self-center px-6 text-center text-xs text-subtle">{pair.note.text}</p>
              ) : (
              <p className="self-end whitespace-pre-wrap text-xs text-subtle">
                {pair.note.kind === "steer" ? "走向" : "设定"} · {pair.note.text}
              </p>
              )
            ) : null}
            {pair.user ? (
              editingId === pair.user.id ? (
                <div className="flex w-full flex-col items-end gap-2">
                  <Textarea
                    ref={editorRef}
                    autoFocus
                    enterKeyHint="done"
                    value={editDraft ?? stripAcousticTags(pair.user.text)}
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
                <UserBubble
                  user={pair.user}
                  editable={editableId === pair.user.id}
                  debugHearing={debugHearing}
                  onEditStart={onEditStart}
                  onConfirmStart={onConfirmStart}
                  onConfirmQuick={onConfirmQuick}
                  onUndoConfirm={onUndoConfirm}
                  undoConfirmId={undoConfirmId}
                  onNoiseReply={onNoiseReply}
                />
              )
            ) : null}
            {(() => {
              const replies = pair.replies ?? (pair.assistant ? [pair.assistant] : []);
              const shown = pair.assistant;
              if (!shown || (!shown.text.trim() && replies.length < 2)) return null;
              const page = Math.max(0, replies.findIndex((reply) => reply.id === shown.id));
              return (
              <div className="flex max-w-[min(22rem,92%)] flex-col gap-6 self-start">
                {shown.text.trim() ? (
                <div className="flex items-start gap-2">
                  {!shown.replyTo && shown.createdAt > lastUserAt ? (
                    <span aria-label="还没回" className="mt-3 size-2 shrink-0 rounded-full bg-live" />
                  ) : null}
                  <div className="min-w-0">
                    <p className="whitespace-pre-wrap break-words font-display text-lg font-medium leading-relaxed tracking-tight text-fg">
                      {shown.text}
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
                {onFlagReply && shown.text.trim() ? (
                  <div className="relative z-10 flex items-center gap-6 self-start">
                    <button
                      type="button"
                      aria-label="这条回复好"
                      aria-pressed={praisedIds?.has(shown.id) ?? false}
                      onClick={() => onFlagReply(shown.id, pair.user?.id ?? shown.replyTo, "up")}
                      className={
                        praisedIds?.has(shown.id)
                          ? "grid size-11 place-items-center text-fg [touch-action:manipulation]"
                          : "grid size-11 place-items-center text-subtle transition-colors duration-150 hover:text-fg [touch-action:manipulation]"
                      }
                    >
                      <ThumbsUp className={praisedIds?.has(shown.id) ? "size-4 fill-current" : "size-4"} />
                    </button>
                    <button
                      type="button"
                      aria-label="差在哪"
                      onClick={() => onFlagReply(shown.id, pair.user?.id ?? shown.replyTo, "down")}
                      className="min-h-11 rounded-md px-3 text-sm text-subtle transition-colors duration-150 hover:text-fg [touch-action:manipulation]"
                    >
                      差在哪
                    </button>
                  </div>
                ) : null}
              </div>
              );
            })()}
            {debugHearing && pair.assistant?.talkTrace ? (
              <p className="self-start text-[10px] text-subtle">{formatTalkTrace(pair.assistant.talkTrace)}</p>
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

function UserBubble({
  user,
  editable,
  debugHearing,
  onEditStart,
  onConfirmStart,
  onConfirmQuick,
  onUndoConfirm,
  undoConfirmId,
  onNoiseReply,
}: {
  user: ChatMessage;
  editable: boolean;
  debugHearing?: boolean;
  onEditStart?: (id: string) => void;
  onConfirmStart?: (id: string) => void;
  onConfirmQuick?: (id: string) => void;
  onUndoConfirm?: (id: string) => void;
  undoConfirmId?: string | null;
  onNoiseReply?: (id: string) => void;
}) {
  const canConfirm = Boolean(debugHearing && user.voiceTurnId && onConfirmStart);
  const canMishear = Boolean(!debugHearing && user.voiceTurnId && onConfirmStart);
  const labeled = user.hearingGold === "confirmed";
  const showUndo = Boolean(canConfirm && labeled && undoConfirmId === user.id && onUndoConfirm);
  const holdRef = useRef<number | null>(null);
  function clearHold() {
    if (holdRef.current != null) window.clearTimeout(holdRef.current);
    holdRef.current = null;
  }
  function openMishear() {
    if (!user.voiceTurnId || !onConfirmStart) return;
    onConfirmStart(user.id);
  }
  if (user.nightNoise) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          aria-label="让清然补一次回复"
          onClick={() => onNoiseReply?.(user.id)}
          className="min-h-8 rounded-full bg-surface-2 px-2.5 py-1 text-[11px] leading-none text-subtle transition-colors duration-150 hover:text-fg"
        >
          一声响动
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-end justify-end gap-2">
        {!canConfirm && editable && onEditStart ? (
          <button
            type="button"
            aria-label="改这句话"
            onClick={() => onEditStart(user.id)}
            className="mb-1 shrink-0 text-subtle transition-colors duration-150 hover:text-fg"
          >
            <Pencil className="size-3.5" />
          </button>
        ) : null}
        {canMishear ? (
          <button
            type="button"
            aria-label="听错了"
            onClick={openMishear}
            className="mb-1 shrink-0 text-xs text-subtle transition-colors duration-150 hover:text-fg"
          >
            听错了
          </button>
        ) : null}
        <div
          className="relative flex max-w-[min(20rem,85%)] flex-col items-end"
          onContextMenu={(event) => {
            if (!user.voiceTurnId || !onConfirmStart) return;
            event.preventDefault();
            openMishear();
          }}
          onPointerDown={() => {
            if (!user.voiceTurnId || !onConfirmStart) return;
            clearHold();
            holdRef.current = window.setTimeout(openMishear, 550);
          }}
          onPointerUp={clearHold}
          onPointerLeave={clearHold}
          onPointerCancel={clearHold}
        >
          {labeled ? (
            <span
              className="absolute -right-1 -top-1 size-2 rounded-full bg-emerald-500"
              aria-label="已标注"
            />
          ) : null}
          <p className="whitespace-pre-wrap break-words rounded-2xl bg-surface-2 px-3.5 py-2 text-sm leading-relaxed text-fg">
            {stripAcousticTags(user.text)}
          </p>
          {debugHearing && (user.hearingTiming || user.injectLine) ? (
            <p className="text-[10px] text-subtle">
              {user.hearingTiming
                ? [
                    user.hearingTiming.hearMs != null ? `说完→识别完 ${user.hearingTiming.hearMs}ms` : null,
                    user.hearingTiming.grokMs != null ? `识别完→字 ${user.hearingTiming.grokMs}ms` : null,
                    user.hearingTiming.ttftMs != null ? `首字 ${user.hearingTiming.ttftMs}ms` : null,
                    user.hearingTiming.ttsMs != null ? `→出声 ${user.hearingTiming.ttsMs}ms` : null,
                    user.hearingTiming.engine ?? null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : null}
              {user.injectLine ? <span className="mt-0.5 block">{user.injectLine}</span> : null}
            </p>
          ) : null}
        </div>
      </div>
      {canConfirm ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="确认正确"
            onClick={() => onConfirmQuick?.(user.id)}
            className="grid size-8 place-items-center rounded-md text-subtle transition-colors duration-150 hover:text-fg"
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="打开标注"
            onClick={() => onConfirmStart?.(user.id)}
            className="grid size-8 place-items-center rounded-md text-subtle transition-colors duration-150 hover:text-fg"
          >
            <Pencil className="size-3.5" />
          </button>
          {showUndo ? (
            <button
              type="button"
              aria-label="撤销标注"
              onClick={() => onUndoConfirm?.(user.id)}
              className="min-h-8 rounded-md px-2 text-xs text-muted"
            >
              撤销
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

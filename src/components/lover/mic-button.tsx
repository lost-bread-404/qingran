import { LoaderCircle, Mic } from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

/** How far up (px) she slides before letting go drops the line. */
const CANCEL_PX = 64;

type Props = {
  /** Her last line is still being finished (its words are coming in). Pressing again still works. */
  busy: boolean;
  /** How loud the mic hears her, 0–1 (only where the page has the mic). */
  level: number;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onHoldCancel: () => void;
};

/**
 * Hold to talk: a wide bar, so a press anywhere on it takes. The press shows at once (the sound and the buzz come from
 * the hold itself); sliding up shows 松开取消, and letting go there drops the line.
 */
export function MicButton({ busy, level, onHoldStart, onHoldEnd, onHoldCancel }: Props) {
  const armedRef = useRef(false);
  const startYRef = useRef(0);
  const leavingRef = useRef(false);
  const [pressed, setPressed] = useState(false);
  const [leaving, setLeaving] = useState(false);

  function pointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (armedRef.current) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    armedRef.current = true;
    startYRef.current = e.clientY;
    leavingRef.current = false;
    setPressed(true);
    setLeaving(false);
    onHoldStart();
  }

  function pointerMove(e: PointerEvent<HTMLButtonElement>) {
    if (!armedRef.current) return;
    const away = startYRef.current - e.clientY > CANCEL_PX;
    if (away === leavingRef.current) return;
    leavingRef.current = away;
    setLeaving(away);
  }

  function letGo(e: PointerEvent<HTMLButtonElement>) {
    if (!armedRef.current) return;
    armedRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const cancel = leavingRef.current;
    leavingRef.current = false;
    setPressed(false);
    setLeaving(false);
    if (cancel) onHoldCancel();
    else onHoldEnd();
  }

  return (
    <button
      type="button"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={letGo}
      onPointerCancel={letGo}
      onLostPointerCapture={letGo}
      onContextMenu={(e) => e.preventDefault()}
      aria-pressed={pressed}
      aria-label={pressed ? (leaving ? "松开取消" : "松开发送") : "按住说话"}
      className={cn(
        "relative flex h-16 min-w-0 flex-1 items-center justify-center gap-2 overflow-hidden rounded-full text-base",
        "touch-none select-none [-webkit-touch-callout:none] [-webkit-user-select:none]",
        "transition-[background-color,transform] duration-75 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        pressed
          ? leaving
            ? "scale-[0.98] bg-surface-2 text-muted"
            : "scale-[0.98] bg-live text-fg"
          : "bg-accent text-accent-fg",
      )}
    >
      {pressed && !leaving ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 bg-fg/10 transition-[width] duration-100"
          style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }}
        />
      ) : null}
      {busy && !pressed ? <LoaderCircle className="size-5 animate-spin" /> : <Mic className="size-5" />}
      <span className="relative">{pressed ? (leaving ? "松开 取消" : "松开 发送 · 上滑 取消") : "按住 说话"}</span>
    </button>
  );
}

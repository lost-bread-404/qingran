import { LoaderCircle, Mic } from "lucide-react";
import { useRef, type PointerEvent } from "react";
import { tapHaptic } from "@/lib/lover/audio";
import { cn } from "@/lib/utils";

type Props = {
  recording: boolean;
  busy: boolean;
  level: number;
  disabled?: boolean;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  ariaLabel?: string;
};

export function MicButton({
  recording,
  busy,
  level,
  disabled,
  onHoldStart,
  onHoldEnd,
  ariaLabel,
}: Props) {
  const armedRef = useRef(false);
  const scale = recording ? 1 + Math.min(level, 0.35) * 0.28 : 1;

  function pointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    try {
      e.currentTarget.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    armedRef.current = true;
    tapHaptic("start");
    onHoldStart();
  }

  function pointerUp(e: PointerEvent<HTMLButtonElement>) {
    if (!armedRef.current) return;
    armedRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    tapHaptic("end");
    onHoldEnd();
  }

  return (
    <button
      type="button"
      onPointerDown={pointerDown}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      onContextMenu={(e) => e.preventDefault()}
      disabled={disabled}
      aria-pressed={recording}
      aria-label={ariaLabel ?? (recording ? "松开发送" : "按住说话")}
      className={cn(
        "relative grid size-24 place-items-center rounded-full transition-[background-color] duration-150 ease-out",
        "touch-none select-none [-webkit-touch-callout:none] [-webkit-user-select:none]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        "disabled:opacity-40",
        recording ? "bg-live text-fg" : "bg-accent text-accent-fg",
      )}
      style={{ transform: `scale(${scale})` }}
    >
      {recording ? (
        <>
          <span className="live-ring pointer-events-none absolute inset-0 rounded-full border border-live" />
          <span
            className="live-ring pointer-events-none absolute -inset-3 rounded-full border border-live/50"
            style={{ animationDelay: "280ms" }}
          />
          <Mic className="size-7" />
        </>
      ) : busy ? (
        <LoaderCircle className="size-7 animate-spin" />
      ) : (
        <Mic className="size-7" />
      )}
    </button>
  );
}

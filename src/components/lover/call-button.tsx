import { Phone, PhoneOff } from "lucide-react";
import type { PointerEvent } from "react";
import { cn } from "@/lib/utils";

type Props = {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
};

export function CallButton({ active, disabled, onClick }: Props) {
  function pointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    onClick();
  }

  return (
    <button
      type="button"
      onPointerDown={pointerDown}
      disabled={disabled}
      aria-pressed={active}
      aria-label={active ? "挂断" : "开始通话"}
      className={cn(
        "relative grid place-items-center rounded-full transition-[background-color] duration-150 ease-out",
        "touch-none select-none [-webkit-touch-callout:none]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        "disabled:opacity-40",
        active ? "size-24 bg-live text-fg" : "size-16 bg-surface-2 text-fg",
        !disabled && "active:scale-[0.96]",
      )}
    >
      {active ? <PhoneOff className="size-7" /> : <Phone className="size-5" />}
    </button>
  );
}

/** The page's audio and the app going to the background (iOS pauses a hidden page). */

export function pageIsHidden() {
  if (typeof document === "undefined") return false;
  const doc = document as Document & { webkitHidden?: boolean; webkitVisibilityState?: string };
  if (document.visibilityState === "hidden") return true;
  if (doc.webkitVisibilityState === "hidden") return true;
  if (doc.webkitHidden === true) return true;
  return false;
}

function isStandalonePwa() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone) return true;
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

export async function resumeAudioContext(ctx: AudioContext): Promise<boolean> {
  const state = ctx.state as string;
  if (state === "closed") return false;
  if (state === "suspended" || state === "interrupted") {
    try {
      await ctx.resume();
    } catch {
      /* iOS sometimes rejects until a later turn */
    }
  }
  return ctx.state === "running";
}

export function listenAppLifecycle(handlers: { onForeground?: () => void; onBackground?: () => void }) {
  if (typeof document === "undefined") return () => undefined;
  let inBackground = pageIsHidden();
  const notify = (hidden: boolean) => {
    if (hidden === inBackground) return;
    inBackground = hidden;
    if (hidden) handlers.onBackground?.();
    else handlers.onForeground?.();
  };
  const goBackground = () => notify(true);
  const goForeground = () => notify(false);
  const onVisibility = () => notify(pageIsHidden());
  const onBlur = () => {
    if (pageIsHidden() || isStandalonePwa()) goBackground();
  };

  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("webkitvisibilitychange", onVisibility);
  document.addEventListener("freeze", goBackground);
  document.addEventListener("resume", goForeground);
  window.addEventListener("pageshow", goForeground);
  window.addEventListener("pagehide", goBackground);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", goForeground);

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("webkitvisibilitychange", onVisibility);
    document.removeEventListener("freeze", goBackground);
    document.removeEventListener("resume", goForeground);
    window.removeEventListener("pageshow", goForeground);
    window.removeEventListener("pagehide", goBackground);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", goForeground);
  };
}

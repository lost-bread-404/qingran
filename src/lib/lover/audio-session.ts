export function audioContextNeedsResume(state: string) {
  return state === "suspended" || state === "interrupted";
}

export function isInterruptedState(state?: string | null) {
  if (!state) return false;
  return state === "interrupted" || state.startsWith("interrupted");
}

export function sessionIsActive(state?: string | null) {
  return state === "active";
}

export function pageIsHidden() {
  if (typeof document === "undefined") return false;
  const doc = document as Document & { webkitHidden?: boolean; webkitVisibilityState?: string };
  if (document.visibilityState === "hidden") return true;
  if (doc.webkitVisibilityState === "hidden") return true;
  if (doc.webkitHidden === true) return true;
  return false;
}

export function isStandalonePwa() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone) return true;
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

export type AudioSessionKind = "listen" | "speak" | "yield";

export function sessionTypeFor(kind: AudioSessionKind) {
  if (kind === "listen") return "play-and-record";
  // Ambient mixes with Sleep Cycle / other alarms. Playback would duck them.
  return "ambient";
}

export function micTrackUsable(track: { readyState: string; muted: boolean }) {
  return track.readyState === "live";
}

export function micTrackHearing(track: { readyState: string; muted: boolean }) {
  return track.readyState === "live" && !track.muted;
}

export function micStreamUsable(
  stream: {
    active: boolean;
    getAudioTracks: () => Array<{ readyState: string; muted: boolean }>;
  } | null,
) {
  if (!stream?.active) return false;
  return stream.getAudioTracks().some(micTrackUsable);
}

export function micStreamHearing(
  stream: {
    active: boolean;
    getAudioTracks: () => Array<{ readyState: string; muted: boolean }>;
  } | null,
) {
  if (!stream?.active) return false;
  return stream.getAudioTracks().some(micTrackHearing);
}

type NavAudioSession = {
  type: string;
  state?: string;
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
};

export function getAudioSession(): NavAudioSession | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as Navigator & { audioSession?: NavAudioSession }).audioSession ?? null;
}

export function audioSessionIsInterrupted() {
  return isInterruptedState(getAudioSession()?.state);
}

export function setAudioSessionKind(kind: AudioSessionKind) {
  const session = getAudioSession();
  if (!session) return;
  try {
    session.type = sessionTypeFor(kind);
    if (kind === "yield") {
      try {
        session.type = "auto";
      } catch {
        /* keep ambient */
      }
    }
  } catch {
    /* older WebKit */
  }
}

export function claimListenSession() {
  setAudioSessionKind("listen");
}

export function yieldAudioSession() {
  setAudioSessionKind("yield");
}

export function primeAudioSession() {
  claimListenSession();
}

export async function resumeAudioContext(ctx: AudioContext): Promise<boolean> {
  if ((ctx.state as string) === "closed") return false;
  if (audioContextNeedsResume(ctx.state)) {
    try {
      await ctx.resume();
    } catch {
      /* iOS sometimes rejects until a later turn */
    }
  }
  if (ctx.state !== "running") return false;
  const apple =
    typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!apple) return true;

  const t0 = ctx.currentTime;
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 48);
  });
  if ((ctx.state as string) === "closed") return false;
  if (ctx.currentTime > t0 + 0.0001) return true;

  try {
    await ctx.suspend();
  } catch {
    /* ignore */
  }
  try {
    await ctx.resume();
  } catch {
    /* ignore */
  }
  const t1 = ctx.currentTime;
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 48);
  });
  return ctx.state === "running" && ctx.currentTime > t1 + 0.0001;
}

export function listenAudioSession(handlers: {
  onInterrupted?: () => void;
  onActive?: () => void;
}) {
  const session = getAudioSession();
  if (!session?.addEventListener) return () => undefined;
  const onState = () => {
    if (isInterruptedState(session.state)) handlers.onInterrupted?.();
    else if (sessionIsActive(session.state)) handlers.onActive?.();
  };
  session.addEventListener("statechange", onState);
  return () => session.removeEventListener?.("statechange", onState);
}

export type LifecyclePhase = "foreground" | "background" | null;

export function createAppLifecycleGate(startHidden: boolean) {
  let inBackground = startHidden;
  return {
    get inBackground() {
      return inBackground;
    },
    notify(hiddenNow: boolean): LifecyclePhase {
      if (hiddenNow === inBackground) return null;
      inBackground = hiddenNow;
      return hiddenNow ? "background" : "foreground";
    },
  };
}

export function listenAppLifecycle(handlers: {
  onForeground?: () => void;
  onBackground?: () => void;
}) {
  if (typeof document === "undefined") return () => undefined;

  const gate = createAppLifecycleGate(pageIsHidden());

  const emit = (phase: LifecyclePhase) => {
    if (phase === "background") handlers.onBackground?.();
    if (phase === "foreground") handlers.onForeground?.();
  };

  const goBackground = () => emit(gate.notify(true));
  const goForeground = () => emit(gate.notify(false));

  const onVisibility = () => {
    if (pageIsHidden()) goBackground();
    else goForeground();
  };

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

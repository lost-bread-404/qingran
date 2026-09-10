export function audioContextNeedsResume(state: string) {
  return state === "suspended" || state === "interrupted";
}

export function micTrackUsable(track: { readyState: string; muted: boolean }) {
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

export function primeAudioSession() {
  const session = getAudioSession();
  if (!session) return;
  try {
    session.type = "play-and-record";
  } catch {
    /* older WebKit */
  }
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

export function listenAppLifecycle(handlers: {
  onForeground?: () => void;
  onBackground?: () => void;
}) {
  if (typeof document === "undefined") return () => undefined;

  const onForeground = () => {
    if (document.visibilityState === "hidden") return;
    handlers.onForeground?.();
  };
  const onBackground = () => handlers.onBackground?.();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") onBackground();
    else onForeground();
  };

  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("webkitvisibilitychange", onVisibility);
  document.addEventListener("freeze", onBackground);
  document.addEventListener("resume", onForeground);
  window.addEventListener("pageshow", onForeground);
  window.addEventListener("pagehide", onBackground);
  window.addEventListener("focus", onForeground);

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("webkitvisibilitychange", onVisibility);
    document.removeEventListener("freeze", onBackground);
    document.removeEventListener("resume", onForeground);
    window.removeEventListener("pageshow", onForeground);
    window.removeEventListener("pagehide", onBackground);
    window.removeEventListener("focus", onForeground);
  };
}

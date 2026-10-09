import { useCallback, useEffect, useRef, useState } from "react";
import { listenAppLifecycle } from "@/lib/lover/audio-session";
import {
  listenNative,
  listenNativeHangup,
  nativeEndCall,
  nativeKeepAwake,
  nativeStartCall,
  shellCalls,
} from "@/lib/lover/native-shell";
import { WebCall } from "@/lib/lover/voice/web-call";

/**
 * A call (requirements 第 7 节). In the iPhone shell the shell runs it (it goes on in the background) and the page
 * shows what the shell reports; in a browser the page runs it (voice/web-call.ts) and its lines come to `onLine`.
 */

/** The shell's phases ("thinking" and "speaking" are his). In a browser the page's own status says these. */
export type CallPhase = "idle" | "listening" | "speaking-you" | "transcribing" | "thinking" | "speaking";

type Options = {
  /** Her 「停多久算说完」 (ms). */
  wait: number;
  keyterms: readonly string[];
  /** A browser call: a line she finished. */
  onLine: (text: string) => void;
  /** A browser call: what she is saying right now changed (empty: she is not saying anything). */
  onLive: (text: string) => void;
  onError: (message: string) => void;
};

function micHint(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风没开：允许这个网页用麦克风再打。";
  return "这会儿开不了麦克风。";
}

export function useCall({ wait, keyterms, onLine, onLive, onError }: Options) {
  const [active, setActive] = useState(false);
  const [shell, setShell] = useState(false);
  const [phase, setPhase] = useState<CallPhase>("idle");
  /** What she is saying right now. */
  const [live, setLive] = useState("");
  const activeRef = useRef(false);
  const shellRef = useRef(false);
  const webRef = useRef<WebCall | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const settingsRef = useRef({ wait, keyterms });
  const onLineRef = useRef(onLine);
  const onLiveRef = useRef(onLive);
  const onErrorRef = useRef(onError);
  settingsRef.current = { wait, keyterms };
  onLineRef.current = onLine;
  onLiveRef.current = onLive;
  onErrorRef.current = onError;

  /** The call is over here (she hung up, or the shell ended it). */
  const ended = useCallback(() => {
    activeRef.current = false;
    shellRef.current = false;
    setActive(false);
    setShell(false);
    setPhase("idle");
    setLive("");
    webRef.current?.stop();
    webRef.current = null;
    nativeKeepAwake(false);
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    activeRef.current = true;
    setActive(true);
    setPhase("listening");
    setLive("");
    if (shellCalls()) {
      shellRef.current = true;
      setShell(true);
      nativeStartCall(settingsRef.current.wait);
      nativeKeepAwake(true);
      return;
    }
    const web = new WebCall(() => settingsRef.current, {
      onLive: (text) => {
        if (webRef.current !== web) return;
        setLive(text);
        onLiveRef.current(text);
      },
      onLine: (text) => {
        if (webRef.current === web) onLineRef.current(text);
      },
      onError: (message) => onErrorRef.current(message),
    });
    webRef.current = web;
    try {
      await web.start();
    } catch (err) {
      if (webRef.current !== web) return;
      onErrorRef.current(micHint(err));
      ended();
      return;
    }
    try {
      wakeLockRef.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      /* the screen may sleep */
    }
  }, [ended]);

  const hangup = useCallback(() => {
    if (!activeRef.current) return;
    if (shellRef.current) nativeEndCall();
    ended();
  }, [ended]);

  /** A browser call: his voice started or ended (the shell knows its own). */
  const deaf = useCallback((on: boolean) => webRef.current?.deaf(on), []);

  /** A browser call: seconds of her voice xAI heard since the last turn. */
  const takeSeconds = useCallback(() => webRef.current?.takeSeconds() ?? 0, []);

  useEffect(
    () =>
      listenNative((event) => {
        if (!activeRef.current || !shellRef.current) return;
        if (event.type === "phase") setPhase(event.phase as CallPhase);
        else if (event.type === "partial") setLive(event.text);
        else if (event.type === "ended") ended();
      }),
    [ended],
  );

  useEffect(
    () =>
      listenNativeHangup(() => {
        if (activeRef.current && shellRef.current) ended();
      }),
    [ended],
  );

  useEffect(
    () =>
      listenAppLifecycle({
        onForeground: () => {
          const web = webRef.current;
          if (web) void web.revive().catch(() => onErrorRef.current("麦克风被关掉了，挂断再打一次。"));
        },
      }),
    [],
  );

  useEffect(
    () => () => {
      if (!activeRef.current) return;
      if (shellRef.current) nativeEndCall();
      ended();
    },
    [ended],
  );

  return { active, shell, phase, live, start, hangup, deaf, takeSeconds };
}

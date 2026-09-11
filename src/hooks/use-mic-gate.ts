import { useCallback, useEffect, useState } from "react";
import { acquireMic, acquireMicFromGesture, micFailHint, releaseMic } from "@/lib/lover/audio";
import { listenAppLifecycle, pageIsHidden } from "@/lib/lover/audio-session";

export function useMicGate(opts?: { pausedRef?: { current: boolean } }) {
  const [blocked, setBlocked] = useState(false);
  const [hint, setHint] = useState("点一下，打开麦克风");
  const pausedRef = opts?.pausedRef;

  const connect = useCallback(async (mode?: { gesture?: boolean }) => {
    if (pageIsHidden()) return false;
    if (pausedRef?.current) return false;
    try {
      if (mode?.gesture) await acquireMicFromGesture();
      else await acquireMic();
      setBlocked(false);
      return true;
    } catch (err) {
      setHint(micFailHint(err));
      setBlocked(true);
      return false;
    }
  }, [pausedRef]);

  const dismiss = useCallback(() => {
    setBlocked(false);
  }, []);

  useEffect(() => {
    if (!pausedRef?.current) void connect();
    const stop = listenAppLifecycle({
      onForeground: () => {
        if (pausedRef?.current) return;
        void connect();
      },
      onBackground: () => {
        if (pausedRef?.current) return;
        releaseMic();
      },
    });
    return () => stop();
  }, [connect, pausedRef]);

  useEffect(() => () => releaseMic(), []);

  return { blocked, hint, connect, dismiss };
}

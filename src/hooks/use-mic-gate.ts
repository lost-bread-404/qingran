import { useCallback, useEffect, useState } from "react";
import { acquireMic, micFailHint, releaseMic } from "@/lib/lover/audio";
import {
  audioSessionIsInterrupted,
  listenAppLifecycle,
  pageIsHidden,
} from "@/lib/lover/audio-session";

export function useMicGate() {
  const [blocked, setBlocked] = useState(false);
  const [hint, setHint] = useState("点一下，打开麦克风");

  const connect = useCallback(async () => {
    if (pageIsHidden() || audioSessionIsInterrupted()) return false;
    try {
      await acquireMic();
      setBlocked(false);
      return true;
    } catch (err) {
      setHint(micFailHint(err));
      setBlocked(true);
      return false;
    }
  }, []);

  const dismiss = useCallback(() => {
    setBlocked(false);
  }, []);

  useEffect(() => {
    void connect();
    const stop = listenAppLifecycle({
      onForeground: () => {
        void connect();
      },
      onBackground: () => {
        releaseMic();
      },
    });
    return () => {
      stop();
      releaseMic();
    };
  }, [connect]);

  return { blocked, hint, connect, dismiss };
}

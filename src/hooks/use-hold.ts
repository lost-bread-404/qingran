import { useCallback, useEffect, useRef, useState } from "react";
import { blobToBase64 } from "@/lib/lover/audio";
import { listenNative, nativeHold, shellHolds, type VoiceNote } from "@/lib/lover/native-shell";
import { playCue } from "@/lib/lover/voice/cues";
import { Ear, joinHeard } from "@/lib/lover/voice/ear-client";
import { mic, wavFromFrames } from "@/lib/lover/voice/mic";

/**
 * Hold to talk (requirements 第 7 节). She decides where her line starts and ends: the press is felt and heard at
 * once, her voice streams to xAI while she holds (the words show as she says them), and the line is hers as soon as
 * she lets go. Sliding up before letting go drops it. In the iPhone shell (from 2026-10-06) the shell does all of this
 * with the phone's own mic and haptics, and also asks and speaks his answer (her line and his reply come back as the
 * call's events do); elsewhere the page hears the line and `onHeard` sends it.
 */

export type Held = { text: string; voice: VoiceNote };

type Take = {
  native: boolean;
  ear: Ear | null;
  /** Her voice in this hold, kept until the words are in: read whole if the stream could not be used. */
  frames: Int16Array[];
  cancelled: boolean;
};

type Options = {
  keyterms: readonly string[];
  /** No voice from him (the shell then answers in words only). */
  muted: boolean;
  /** She let go and her words are in (empty: nothing was heard). Not called in the shell, which sends them itself. */
  onHeard: (held: Held) => void;
  onError: (message: string) => void;
};

function micHint(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风没开：允许这个网页用麦克风，或者先打字。";
  return err instanceof Error && /[一-鿿]/.test(err.message) ? err.message : "这会儿开不了麦克风。";
}

/**
 * The stream could not be used: the hold is read at once (/api/stt), a minute at a time so no request is over the
 * server's size limit. What could be read is kept even if a piece failed.
 */
async function readWhole(frames: Int16Array[]): Promise<{ text: string; error?: string }> {
  const pieces: Int16Array[][] = [[]];
  let total = 0;
  let inPiece = 0;
  for (const f of frames) {
    if (inPiece >= 16000 * 60) {
      pieces.push([]);
      inPiece = 0;
    }
    pieces[pieces.length - 1]!.push(f);
    inPiece += f.length;
    total += f.length;
  }
  if (total < 16000 * 0.3) return { text: "" };
  // A last bit under a second goes with the minute before it (too short to read on its own).
  if (pieces.length > 1 && inPiece < 16000) pieces[pieces.length - 2]!.push(...pieces.pop()!);
  const read = await Promise.all(pieces.map(readPiece));
  return {
    text: read.reduce((text, piece) => joinHeard(text, piece.text), ""),
    error: read.find((piece) => piece.error)?.error,
  };
}

async function readPiece(frames: Int16Array[]): Promise<{ text: string; error?: string }> {
  try {
    const res = await fetch("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64: await blobToBase64(wavFromFrames(frames)) }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string };
    if (body.ok) return { text: String(body.text ?? "").trim() };
    return { text: "", error: body.error || "没听清，再说一遍。" };
  } catch {
    return { text: "", error: "这会儿连不上，再说一遍。" };
  }
}

export function useHold({ keyterms, muted, onHeard, onError }: Options) {
  const [holding, setHolding] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [live, setLive] = useState("");
  const [level, setLevel] = useState(0);
  const takeRef = useRef<Take | null>(null);
  /** Holds she let go of whose words are not in yet (outside the shell). */
  const pendingRef = useRef(0);
  const keytermsRef = useRef(keyterms);
  const mutedRef = useRef(muted);
  const onHeardRef = useRef(onHeard);
  const onErrorRef = useRef(onError);
  const nativeWaitRef = useRef(0);
  keytermsRef.current = keyterms;
  mutedRef.current = muted;
  onHeardRef.current = onHeard;
  onErrorRef.current = onError;

  const start = useCallback(() => {
    if (takeRef.current) return;
    const take: Take = { native: shellHolds(), ear: null, frames: [], cancelled: false };
    takeRef.current = take;
    setHolding(true);
    setLive("");
    setLevel(0);
    if (take.native) {
      nativeHold("start", mutedRef.current);
      return;
    }
    playCue("press");
    const ear = new Ear("hold", { keyterms: keytermsRef.current }, {
      onText: (text) => {
        // Words still coming for a line she let go show until a new press takes the line.
        if (!take.cancelled && (!takeRef.current || takeRef.current === take)) setLive(text);
      },
    });
    take.ear = ear;
    mic.onFrame = (frame) => {
      if (take.cancelled) return;
      take.frames.push(frame.pcm);
      ear.send(frame.pcm);
      if (takeRef.current === take) setLevel(Math.min(1, frame.rms * 8));
    };
    mic.start().catch((err) => {
      if (take.cancelled) return;
      onErrorRef.current(micHint(err));
      ear.close();
      // Already let go: finishing it hands on an empty line (nothing was heard).
      if (takeRef.current !== take) return;
      take.cancelled = true;
      takeRef.current = null;
      setHolding(false);
      setLive("");
      // Nothing was heard: whatever waited for this line goes on.
      onHeardRef.current({ text: "", voice: { mode: "hold" } });
    });
  }, []);

  const finishTake = useCallback(async (take: Take) => {
    const t0 = performance.now();
    if (mic.on) await mic.flush();
    // A new hold may already have the mic (she pressed again at once); it keeps it.
    if (!takeRef.current) {
      mic.onFrame = null;
      mic.stop();
    }
    const ear = take.ear;
    let text = ear ? await ear.finish(3000) : null;
    // Done with the stream either way (one that never finished must not go on later, billed and showing words).
    ear?.close();
    let error: string | undefined;
    if (text == null) ({ text, error } = await readWhole(take.frames));
    take.frames = [];
    pendingRef.current = Math.max(0, pendingRef.current - 1);
    setFinishing(pendingRef.current > 0);
    // A new hold may be on already: its words and level stay.
    if (!takeRef.current) {
      setLive("");
      setLevel(0);
    }
    if (take.cancelled) return;
    if (error) onErrorRef.current(error);
    onHeardRef.current({
      text,
      voice: { mode: "hold", ms: Math.round(performance.now() - t0), sec: ear ? Math.round(ear.sent * 10) / 10 : 0 },
    });
  }, []);

  const end = useCallback(() => {
    const take = takeRef.current;
    if (!take) return;
    takeRef.current = null;
    setHolding(false);
    setFinishing(true);
    if (take.native) {
      nativeHold("end");
      // The shell answers with `held`; if it never does, the hold does not stay busy.
      window.clearTimeout(nativeWaitRef.current);
      nativeWaitRef.current = window.setTimeout(() => setFinishing(false), 15000);
      return;
    }
    playCue("release");
    pendingRef.current += 1;
    void finishTake(take);
  }, [finishTake]);

  const cancel = useCallback(() => {
    const take = takeRef.current;
    if (!take) return;
    takeRef.current = null;
    take.cancelled = true;
    setHolding(false);
    setLive("");
    setLevel(0);
    if (take.native) {
      nativeHold("cancel");
      return;
    }
    playCue("cancel");
    take.ear?.close();
    mic.onFrame = null;
    mic.stop();
  }, []);

  useEffect(
    () =>
      listenNative((event) => {
        if (event.type === "hold") setLive(event.text);
        else if (event.type === "held") {
          // The shell has her words and sends them itself (they come back as `heard`); only the hold is over here.
          window.clearTimeout(nativeWaitRef.current);
          setFinishing(false);
          setLive("");
          if (event.error) onErrorRef.current(event.error);
        }
      }),
    [],
  );

  useEffect(
    () => () => {
      const take = takeRef.current;
      if (!take) return;
      takeRef.current = null;
      take.cancelled = true;
      if (take.native) nativeHold("cancel");
      else {
        take.ear?.close();
        mic.onFrame = null;
        mic.stop();
      }
    },
    [],
  );

  /** She is holding, or a line she let go of is still being heard (outside the shell): his voice waits for it. */
  const active = useCallback(() => takeRef.current !== null || pendingRef.current > 0, []);

  return { holding, finishing, live, level, start, end, cancel, active };
}

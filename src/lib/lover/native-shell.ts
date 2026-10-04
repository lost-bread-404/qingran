export type NativeBridge = {
  present?: boolean;
  /** 2 = the shell runs the call itself (same VAD and hearing as the web), in the foreground and the background. */
  nativeCall?: number;
  startCall?: () => void;
  endCall?: () => void;
  prepareAudio?: () => void;
  startNativeCall?: (params?: NativeCallParams) => void;
  endNativeCall?: () => void;
  /** Stop his reply and listen again (she tapped him). Shells built before 2026-09-27 do not have it. */
  interruptNativeCall?: () => void;
  /** Run a turn the page started (edit, re-ask, typed line) inside the shell's call. Shells built before 2026-09-28 do not have it. */
  talkNativeCall?: (turn: NativeTalkTurn) => void;
  /** Speak one of his lines again (she pressed play) inside the shell's call. Shells built before 2026-10-01 do not have it. */
  playNativeCall?: (clip: NativeClip) => void;
  /** Add a line she typed or tapped to the round of the shell's call. Shells built before 2026-10-02 do not have it. */
  addNativeCall?: (text: string, attach: boolean) => void;
  keepAwake?: (on: boolean) => void;
  /** Outside a call: the shell asks and speaks this turn (it goes on in the background). Shells built before 2026-10-04 do not have it. */
  speakTurn?: (turn: NativeSpeakTurn) => void;
  stopSpeaker?: () => void;
};

declare global {
  interface Window {
    QingranNative?: NativeBridge;
  }
}

export type NativeCallStart = "startNativeCall" | "prepareAudio";
export type NativeCallEnd = "endNativeCall" | "none";

/** Her VAD numbers, handed to the shell when a call starts (see src/lib/lover/vad.ts). */
export type NativeCallParams = {
  startMin: number;
  startMult: number;
  holdMin: number;
  holdMult: number;
  startHoldMs: number;
  endWaitMs: number;
  maxUtteranceMs: number;
};

/**
 * Inside the iPhone shell the phone owns every call, like WeChat: the page can be
 * left, the screen locked, and the call goes on. A web page cannot keep the mic in
 * the background. Shells built before this (no nativeCall: 2) and browsers keep
 * the in-page call.
 */
export function nativeCallPlan(): {
  callStart: NativeCallStart;
  callEnd: NativeCallEnd;
} {
  if (isNativeShell() && (window.QingranNative?.nativeCall ?? 0) >= 2) {
    return { callStart: "startNativeCall", callEnd: "endNativeCall" };
  }
  return { callStart: "prepareAudio", callEnd: "none" };
}

export function isNativeShell() {
  if (typeof window === "undefined") return false;
  if (window.QingranNative?.present) return true;
  try {
    return /QingranNative/.test(navigator.userAgent);
  } catch {
    return false;
  }
}

function post(fn: ((bridge: NativeBridge) => void) | null) {
  if (!isNativeShell() || !fn) return;
  try {
    const bridge = window.QingranNative;
    if (bridge) fn(bridge);
  } catch {
    /* web */
  }
}

export function nativePrepareAudio() {
  post((bridge) => bridge.prepareAudio?.());
}

export function nativeKeepAwake(on: boolean) {
  post((bridge) => bridge.keepAwake?.(on));
}

export function nativeStartCall(params: NativeCallParams) {
  const plan = nativeCallPlan();
  if (plan.callStart === "startNativeCall") post((bridge) => bridge.startNativeCall?.(params));
  else nativePrepareAudio();
}

export type NativeTalkTurn = {
  text: string;
  userMsgId: string;
  userCreatedAt: number;
  replyId: string;
  replyCreatedAt: number;
};

/**
 * During the shell's call the shell owns the speaker and the mic, so a turn the page starts is handed to it:
 * it stops what he was saying and speaks the new reply itself. False when there is no shell call (or an old shell).
 */
export function nativeTalkTurn(turn: NativeTalkTurn): boolean {
  if (nativeCallPlan().callStart !== "startNativeCall") return false;
  const bridge = typeof window === "undefined" ? undefined : window.QingranNative;
  if (!bridge?.talkNativeCall) return false;
  try {
    bridge.talkNativeCall(turn);
    return true;
  } catch {
    return false;
  }
}

export type NativeClip = { audio: string; mime: string };

/**
 * During the shell's call she pressed play on one of his lines: the shell stops what was playing and speaks it, mic
 * deaf meanwhile. With null, only says whether the shell can. False when there is no shell call (or an old shell).
 */
export function nativePlayClip(clip: NativeClip | null): boolean {
  if (nativeCallPlan().callStart !== "startNativeCall") return false;
  const bridge = typeof window === "undefined" ? undefined : window.QingranNative;
  if (!bridge?.playNativeCall) return false;
  if (!clip) return true;
  try {
    bridge.playNativeCall(clip);
    return true;
  } catch {
    return false;
  }
}

/**
 * During the shell's call, a line she typed (attach false) or a phrase she tapped (attach true: it goes on the end
 * of the line she is saying, if she is saying one) joins the round like a line she said. With null text, only says
 * whether the shell can. False when there is no shell call (or an old shell).
 */
export function nativeAddToCall(text: string | null, attach = false): boolean {
  if (nativeCallPlan().callStart !== "startNativeCall") return false;
  const bridge = typeof window === "undefined" ? undefined : window.QingranNative;
  if (!bridge?.addNativeCall) return false;
  if (text == null) return true;
  try {
    bridge.addNativeCall(text, attach);
    return true;
  } catch {
    return false;
  }
}

export function nativeInterruptCall() {
  post((bridge) => bridge.interruptNativeCall?.());
}

export function nativeEndCall() {
  const plan = nativeCallPlan();
  if (plan.callEnd === "none") return;
  post((bridge) => bridge.endNativeCall?.());
}

let holdAudioPrepared = false;

/** First push-to-talk of this page posts prepareAudio. Later holds do not. */
export function nativePrepareHoldToTalk() {
  if (holdAudioPrepared) return false;
  holdAudioPrepared = true;
  nativePrepareAudio();
  return true;
}

export function listenNativeHangup(onHangup: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const fn = () => onHangup();
  window.addEventListener("qingran-native-hangup", fn);
  return () => window.removeEventListener("qingran-native-hangup", fn);
}

export type NativeSpeakTurn = NativeTalkTurn & {
  images?: string[];
  profile?: { voiceSpeed: number; muted: boolean };
};

/**
 * Outside a call, a turn she typed is asked and spoken by the shell, not the page: iOS pauses the page when she
 * leaves the app, and his voice and the reply still coming stopped with it (她 2026-10-04). The shell's words come
 * back as the call's do (`reply`). False on the web, in a call, or in an old shell.
 */
export function nativeSpeakTurn(turn: NativeSpeakTurn): boolean {
  const bridge = typeof window === "undefined" ? undefined : window.QingranNative;
  if (!bridge?.speakTurn) return false;
  try {
    bridge.speakTurn(turn);
    return true;
  } catch {
    return false;
  }
}

/** She tapped another line or started holding to talk: the shell's voice stops (the reply is still saved). */
export function nativeSpeakerStop() {
  post((bridge) => bridge.stopSpeaker?.());
}

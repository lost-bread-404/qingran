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
  keepAwake?: (on: boolean) => void;
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

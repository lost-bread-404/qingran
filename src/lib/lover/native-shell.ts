/**
 * The iPhone shell (ios/Qingran) puts `window.QingranNative` on the page. Inside it the phone owns calls, like WeChat:
 * the app can be left and the screen locked and the call goes on, which a web page cannot do. Shells from 2026-10-06
 * (`voice: 3`) also hold to talk themselves, so the press is felt at once (haptics, a tone) and the mic is the phone's.
 * Everything the shell does comes back as `qingran-native-call` events (`NativeEvent`).
 */

export type NativeBridge = {
  present?: boolean;
  /** 2 = the shell runs calls itself. */
  nativeCall?: number;
  /** 3 = the shell holds to talk itself and hears with xAI's stream (2026-10-06). */
  voice?: number;
  startNativeCall?: (params?: Record<string, number>) => void;
  endNativeCall?: () => void;
  /** Stop his reply and listen again (she tapped him). */
  interruptNativeCall?: () => void;
  /** Run a turn the page started (edit, re-ask) inside the shell's call. */
  talkNativeCall?: (turn: NativeTalkTurn) => void;
  /** Speak one of his lines again (she pressed play) inside the shell's call. */
  playNativeCall?: (clip: NativeClip) => void;
  /** Add a line she typed or tapped to the round of the shell's call. */
  addNativeCall?: (text: string, attach: boolean) => void;
  keepAwake?: (on: boolean) => void;
  /** Outside a call: the shell asks and speaks this turn (it goes on in the background). */
  speakTurn?: (turn: NativeSpeakTurn) => void;
  stopSpeaker?: () => void;
  /** Hold to talk: the shell hears the line and then asks and speaks his answer itself, as in a call. */
  holdStart?: (opts?: { muted?: boolean }) => void;
  holdEnd?: () => void;
  holdCancel?: () => void;
};

declare global {
  interface Window {
    QingranNative?: NativeBridge;
  }
}

/** What the shell tells the page. */
export type NativeEvent =
  /** Her line in the call (the same id again replaces its text). */
  | { type: "heard"; id: string; text: string; at?: number }
  /** What she is saying in the call right now (empty: nothing). */
  | { type: "partial"; text: string }
  /** His answer to the round was dropped before she heard it (she went on, tapped him, hung up). */
  | { type: "retract"; id: string }
  | { type: "reply"; id: string; text: string; replyTo?: string }
  | { type: "speakFail"; id: string; text: string }
  | { type: "phase"; phase: string }
  /** Holding to talk: what she is saying so far. */
  | { type: "hold"; text: string }
  /** She let go and the shell has her words (empty: nothing was heard); they come back as `heard`. */
  | { type: "held"; text: string; error?: string }
  | { type: "error"; text: string }
  | { type: "ended" };

export function isNativeShell() {
  if (typeof window === "undefined") return false;
  if (window.QingranNative?.present) return true;
  try {
    return /QingranNative/.test(navigator.userAgent);
  } catch {
    return false;
  }
}

function bridge(): NativeBridge | undefined {
  return typeof window === "undefined" ? undefined : window.QingranNative;
}

/** The shell runs the call (the page only shows it). */
export function shellCalls(): boolean {
  return isNativeShell() && (bridge()?.nativeCall ?? 0) >= 2;
}

/** The shell holds to talk (shells from 2026-10-06); older shells hold to talk in the page. */
export function shellHolds(): boolean {
  return isNativeShell() && (bridge()?.voice ?? 0) >= 3 && typeof bridge()?.holdStart === "function";
}

function post(fn: (b: NativeBridge) => void): boolean {
  const b = bridge();
  if (!isNativeShell() || !b) return false;
  try {
    fn(b);
    return true;
  } catch {
    return false;
  }
}

export function listenNative(onEvent: (event: NativeEvent) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const fn = (event: Event) => {
    const detail = (event as CustomEvent<NativeEvent>).detail;
    if (detail && typeof detail === "object" && typeof detail.type === "string") onEvent(detail);
  };
  window.addEventListener("qingran-native-call", fn);
  return () => window.removeEventListener("qingran-native-call", fn);
}

export function listenNativeHangup(onHangup: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const fn = () => onHangup();
  window.addEventListener("qingran-native-hangup", fn);
  return () => window.removeEventListener("qingran-native-hangup", fn);
}

/**
 * The call starts in the shell. Shells from before 2026-10-06 still decide by loudness when she speaks and need
 * these numbers; newer ones ignore them.
 */
export function nativeStartCall(waitMs: number) {
  post((b) => b.startNativeCall?.({ startMin: 0.015, startHoldMs: 300, endWaitMs: waitMs }));
}

export function nativeEndCall() {
  post((b) => b.endNativeCall?.());
}

export function nativeInterruptCall() {
  post((b) => b.interruptNativeCall?.());
}

export function nativeKeepAwake(on: boolean) {
  post((b) => b.keepAwake?.(on));
}

export function nativeHold(step: "start" | "end" | "cancel", muted = false) {
  post((b) => (step === "start" ? b.holdStart?.({ muted }) : step === "end" ? b.holdEnd?.() : b.holdCancel?.()));
}

/** Her words as she said them (or typed them), for /api/talk: held or in a call, and what xAI heard for it. */
export type VoiceNote = { mode: "hold" | "call"; ms?: number; sec?: number };

export type NativeTalkTurn = {
  text: string;
  userMsgId: string;
  userCreatedAt: number;
  replyId: string;
  replyCreatedAt: number;
};

/**
 * During the shell's call the shell owns the speaker and the mic, so a turn the page starts is handed to it: it stops
 * what he was saying and speaks the new reply itself. False when there is no shell call.
 */
export function nativeTalkTurn(turn: NativeTalkTurn): boolean {
  if (!shellCalls() || !bridge()?.talkNativeCall) return false;
  return post((b) => b.talkNativeCall?.(turn));
}

export type NativeClip = { audio: string; mime: string };

/** She pressed play on one of his lines during the shell's call: the shell speaks it (the mic is deaf meanwhile). */
export function nativePlayClip(clip: NativeClip): boolean {
  if (!shellCalls() || !bridge()?.playNativeCall) return false;
  return post((b) => b.playNativeCall?.(clip));
}

/**
 * During the shell's call, a line she typed (attach false) or a phrase she tapped (attach true: it goes on the end of
 * the line she is saying, if she is saying one) joins the round like a line she said. With null text, only says
 * whether the shell can.
 */
export function nativeAddToCall(text: string | null, attach = false): boolean {
  if (!shellCalls() || !bridge()?.addNativeCall) return false;
  if (text == null) return true;
  return post((b) => b.addNativeCall?.(text, attach));
}

export type NativeSpeakTurn = NativeTalkTurn & {
  images?: string[];
  /** Her round: earlier lines she said before this one, not yet answered aloud (see /api/talk). */
  earlier?: Array<{ id: string; text: string; at: number }>;
  voice?: VoiceNote;
  profile?: { voiceSpeed: number; muted: boolean };
};

/**
 * Outside a call, a turn is asked and spoken by the shell, not the page: iOS pauses the page when she leaves the app,
 * and his voice and the reply still coming stopped with it (她 2026-10-04). The shell's words come back as `reply`
 * events. False on the web or in a call.
 */
export function nativeSpeakTurn(turn: NativeSpeakTurn): boolean {
  if (!bridge()?.speakTurn) return false;
  return post((b) => b.speakTurn?.(turn));
}

/**
 * She pressed play on a line, started a call, or (older shells) started holding to talk: the shell's voice stops, as
 * when she taps him. What she already heard of his reply is saved; shells from 2026-10-06 also drop a reply she has
 * not heard yet (her line then goes with what she says next).
 */
export function nativeSpeakerStop() {
  post((b) => b.stopSpeaker?.());
}

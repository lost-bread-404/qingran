export type NativeBridge = {
  present?: boolean;
  startCall?: () => void;
  endCall?: () => void;
  prepareAudio?: () => void;
  startNativeCall?: () => void;
  endNativeCall?: () => void;
  keepAwake?: (on: boolean) => void;
};

declare global {
  interface Window {
    QingranNative?: NativeBridge;
  }
}

export type NativeCallStart = "startNativeCall" | "prepareAudio";
export type NativeCallEnd = "endNativeCall" | "none";

/** Native pipeline only inside the iOS shell, and only when Rosie turned the switch on. */
export function nativeCallPlan(callKitBackground: boolean): {
  callStart: NativeCallStart;
  callEnd: NativeCallEnd;
} {
  if (callKitBackground && isNativeShell()) return { callStart: "startNativeCall", callEnd: "endNativeCall" };
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

export function nativeStartCall(callKitBackground: boolean) {
  const plan = nativeCallPlan(callKitBackground);
  if (plan.callStart === "startNativeCall") post((bridge) => bridge.startNativeCall?.());
  else nativePrepareAudio();
}

export function nativeEndCall(callKitBackground: boolean) {
  const plan = nativeCallPlan(callKitBackground);
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

export function resetNativeHoldPrep() {
  holdAudioPrepared = false;
}

export function listenNativeHangup(onHangup: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const fn = () => onHangup();
  window.addEventListener("qingran-native-hangup", fn);
  return () => window.removeEventListener("qingran-native-hangup", fn);
}

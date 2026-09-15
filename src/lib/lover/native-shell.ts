export type NativeBridge = {
  present?: boolean;
  startCall?: () => void;
  endCall?: () => void;
};

declare global {
  interface Window {
    QingranNative?: NativeBridge;
  }
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

export function nativeStartCall() {
  if (!isNativeShell()) return;
  try {
    window.QingranNative?.startCall?.();
  } catch {
    /* web */
  }
}

export function nativeEndCall() {
  if (!isNativeShell()) return;
  try {
    window.QingranNative?.endCall?.();
  } catch {
    /* web */
  }
}

export function listenNativeHangup(onHangup: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const fn = () => onHangup();
  window.addEventListener("qingran-native-hangup", fn);
  return () => window.removeEventListener("qingran-native-hangup", fn);
}

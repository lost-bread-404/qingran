import { getHearingSession } from "./hearing/session.ts";

export type CallAudioEvent = { at: number; event: string };

export const AUDIO_LOG_MAX = 80;
const events: CallAudioEvent[] = [];
const listeners = new Set<() => void>();
let tracing = false;

export function logCallAudio(event: string) {
  events.push({ at: Date.now(), event });
  if (events.length > AUDIO_LOG_MAX) events.shift();
  if (!getHearingSession().debugHearing) return;
  console.info(`[qingran-audio] ${event}`);
  listeners.forEach((fn) => fn());
}

export function recentCallAudioLog(n = 8): CallAudioEvent[] {
  return events.slice(-n);
}

export function subscribeCallAudioLog(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function stamp(at: number) {
  const t = new Date(at);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  const ms = String(t.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function formatCallAudioLogLines(rows = recentCallAudioLog(AUDIO_LOG_MAX)): string {
  return rows.map((row) => `${stamp(row.at)} ${row.event}`).join("\n");
}

/** One-shot listeners so hide/show is logged even when no call is up. */
export function installAudioTrace() {
  if (tracing || typeof document === "undefined") return;
  tracing = true;
  document.addEventListener("visibilitychange", () => {
    logCallAudio(`visibilitychange ${document.visibilityState}`);
  });
  document.addEventListener("freeze", () => {
    logCallAudio("freeze");
  });
  window.addEventListener("pagehide", () => {
    logCallAudio("pagehide");
  });
  window.addEventListener("pageshow", () => {
    logCallAudio("pageshow");
  });
}

import { getHearingSession } from "./hearing/session.ts";

export type CallAudioEvent = { at: number; event: string };

const MAX = 24;
const events: CallAudioEvent[] = [];
const listeners = new Set<() => void>();

export function logCallAudio(event: string) {
  events.push({ at: Date.now(), event });
  if (events.length > MAX) events.shift();
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

export function formatCallAudioLog(rows = recentCallAudioLog(6)): string {
  return rows
    .map((row) => {
      const t = new Date(row.at);
      const mm = String(t.getMinutes()).padStart(2, "0");
      const ss = String(t.getSeconds()).padStart(2, "0");
      const ms = String(t.getMilliseconds()).padStart(3, "0");
      return `${mm}:${ss}.${ms} ${row.event}`;
    })
    .join(" · ");
}

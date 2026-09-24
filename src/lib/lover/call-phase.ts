export const CALL_STUCK_MS = 5_000;

/** True when a live call has stopped accepting speech and nothing else is busy. */
export function callListenStuck(input: {
  phase: string;
  deaf: boolean;
  playing: boolean;
  generating: boolean;
  recognizing: boolean;
  labeling: boolean;
  stuckForMs: number;
  limitMs?: number;
}): boolean {
  if (input.playing || input.generating || input.recognizing || input.labeling) return false;
  if (input.phase === "speaking-you") return false;
  if (input.phase === "listening" && !input.deaf) return false;
  return input.stuckForMs >= (input.limitMs ?? CALL_STUCK_MS);
}

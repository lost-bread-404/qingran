/** Replay-friendly wall clock. Duration measurements still use Date.now(). */

let clock: () => number = () => Date.now();

export function now(): number {
  return clock();
}


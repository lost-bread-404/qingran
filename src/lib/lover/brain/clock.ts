/** Replay-friendly wall clock. Duration measurements still use Date.now(). */

let clock: () => number = () => Date.now();

export function now(): number {
  return clock();
}

export function setClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

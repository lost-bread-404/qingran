import { ROUTES, type Route } from "./config.ts";
import type { JobType } from "./types.ts";

export const LONG_JOBS = new Set<JobType>(["reflect", "synth", "report"]);

export function timeoutFor(type: JobType): number {
  const route = (type === "backfill" ? "backfill" : type) as Route;
  return ROUTES[route]?.timeoutMs ?? 30_000;
}

export function canStartJob(type: JobType, remainingMs: number): boolean {
  if (!LONG_JOBS.has(type)) return true;
  return remainingMs >= timeoutFor(type);
}

export function retryDelayMs(attempts: number): number {
  return 30_000 * 2 ** Math.max(0, attempts - 1);
}

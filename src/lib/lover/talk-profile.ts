import { lockedProfile, type Profile } from "./types.ts";

/** Missing profile uses the saved one. A provided profile is locked as-is. */
export function resolveTalkProfile(given: unknown, saved: unknown): Profile {
  if (given == null) return lockedProfile(saved);
  return lockedProfile(given);
}

import { lockedProfile, NEUTRAL_PERSONA, storedSystemPrompt, type Profile } from "./types.ts";

export type ResolvedTalkProfile = {
  profile: Profile;
  personaMissing: boolean;
};

/**
 * Persona, model, and what gets injected come from the saved profile.
 * The client may still choose playback (speed, mute).
 */
export function resolveTalkProfile(given: unknown, saved: unknown): ResolvedTalkProfile {
  const savedProfile = lockedProfile(saved);
  const stored = storedSystemPrompt(saved);
  const personaMissing = !stored;
  const profile: Profile = {
    ...savedProfile,
    systemPrompt: stored || NEUTRAL_PERSONA,
  };
  if (given && typeof given === "object") {
    const client = lockedProfile(given);
    profile.voiceSpeed = client.voiceSpeed;
    profile.muted = client.muted;
    if (given && typeof given === "object" && "mode" in given) profile.mode = client.mode;
  }
  if (profile.mode === "real") {
    profile.voiceModel = profile.realModel;
    profile.voiceEffort = profile.realEffort;
    if (profile.realPrompt.trim()) profile.systemPrompt = profile.realPrompt;
  }
  return { profile, personaMissing };
}

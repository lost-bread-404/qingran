import { lockedProfile, NEUTRAL_PERSONA, storedSystemPrompt, type Profile } from "./types.ts";

/** A mode sets the tone, not a script: what is really happening and how he feels come first. */
const MODE_FRAME = "现在大致是这样的时候。这是基调，不是规定：眼前真的发生了什么、你心里是什么感觉，比这里写的优先；场面变了，就按场面来。";

export type ResolvedTalkProfile = {
  profile: Profile;
  personaMissing: boolean;
};

/**
 * Persona, model, and what gets injected come from the saved profile.
 * The client may still choose playback (speed, mute).
 */
export function resolveTalkProfile(given: unknown, saved: unknown, mode?: string): ResolvedTalkProfile {
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
  }
  if (mode) profile.mode = mode;
  // One reply model for every mode; a mode only adds its own prompt after the persona.
  const def = profile.modes.find((m) => m.id === profile.mode);
  if (def?.prompt.trim()) profile.systemPrompt = `${profile.systemPrompt.trim()}\n\n${MODE_FRAME}\n${def.prompt.trim()}`;
  return { profile, personaMissing };
}

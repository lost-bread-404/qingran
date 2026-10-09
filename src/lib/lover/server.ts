import { createServerFn } from "@tanstack/react-start";
import { spokenForTts } from "./speech-tags";
import { ttsSpeed } from "./tts";
import { castOf } from "./cast";
import { speakWhole } from "./speak";

type TtsInput = {
  text: string;
  speed?: number;
};

/** One of his lines read again (she pressed play): each person's part in his own voice. */
export const speakAsLover = createServerFn({ method: "POST" })
  .validator((input: TtsInput) => input)
  .handler(async ({ data }) => {
    if (!spokenForTts(data.text.trim())) return { ok: false as const, error: "empty" };
    const [{ getProfileData }, { lockedProfile }] = await Promise.all([import("./brain/store"), import("./types")]);
    const cast = castOf(lockedProfile(await getProfileData().catch(() => ({}))));
    const spoken = await speakWhole(data.text, cast, ttsSpeed(data.speed ?? 1));
    if (!spoken.ok) return { ok: false as const, error: spoken.error };
    return {
      ok: true as const,
      mimeType: spoken.mime,
      audioBase64: spoken.audio.toString("base64"),
    };
  });

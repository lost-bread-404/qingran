import { VOICE_IO } from "./brain/config";
import { recordTtsSpend } from "./brain/spend/check";
import { splitSpeakers, type Cast } from "./cast";
import { spokenForTts } from "./speech-tags";
import { ttsRequestBody } from "./tts";
import { levelClip } from "./voice-level";
import { readXaiFail } from "./xai-error";
import { xaiFetch } from "./xai-auth";

export const PCM_MIME = `audio/pcm;rate=${VOICE_IO.sampleRate}`;

export type Spoken =
  { ok: true; audio: Buffer; mime: string; chars: number } | { ok: false; error: string };

/**
 * A whole reply read in one go (replay, and when the live voice did not finish): each person's part in his voice,
 * read at the same time, then joined in order. Raw PCM joins end to end.
 */
export async function speakWhole(text: string, cast: Cast, speed: number): Promise<Spoken> {
  const parts = splitSpeakers(text, cast)
    .map((p) => ({ voice: p.voice, text: spokenForTts(p.text) }))
    .filter((p) => p.text);
  if (!parts.length) return { ok: false, error: "empty" };
  const readPart = async (p: { voice: string; text: string }): Promise<Spoken> => {
    const got = await readOne(p, speed);
    // A voice name xAI does not know (a typo in her table) still gets read, in Eve's voice.
    return got.ok || p.voice === VOICE_IO.voice ? got : readOne({ ...p, voice: VOICE_IO.voice }, speed);
  };
  const read = await Promise.all(parts.map(readPart));
  const failed = read.find((r) => !r.ok);
  if (failed) return failed;
  const done = read as Array<Extract<Spoken, { ok: true }>>;
  return {
    ok: true,
    audio: Buffer.concat(done.map((r) => r.audio)),
    mime: done[0]!.mime,
    chars: done.reduce((n, r) => n + r.chars, 0),
  };
}

async function readOne(p: { voice: string; text: string }, speed: number): Promise<Spoken> {
  try {
    const sent = await xaiFetch(VOICE_IO.ttsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ttsRequestBody(p.text, VOICE_IO.language, speed, p.voice)),
      signal: AbortSignal.timeout(40_000),
    });
    if (!sent) return { ok: false, error: "voice-unavailable" };
    if (!sent.res.ok) return { ok: false, error: await readXaiFail(sent.res) };
    void recordTtsSpend(p.text.length, null, sent.cred.kind);
    const mime = sent.res.headers.get("content-type") || PCM_MIME;
    return {
      ok: true,
      audio: levelClip(Buffer.from(await sent.res.arrayBuffer()), mime),
      mime,
      chars: p.text.length,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "voice-unavailable" };
  }
}

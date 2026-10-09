import { createServerFn } from "@tanstack/react-start";
import WebSocket from "ws";
import { VOICE_IO } from "./brain/config";
import { ttsRequestBody } from "./tts";
import { xaiCreds } from "./xai-auth";
import { assertLab } from "./hearing/store";
import { TONE_CASES } from "./tone-cases";

/**
 * Does Eve act on a speech tag? One case from tone-cases.ts read over the one-shot HTTP voice or the live WebSocket
 * voice, back with its length, how loud the voiced part is, and what xAI hears in it (a tag read out as a word shows up
 * there). One case per call, so the page reads the one she taps.
 */
const RATE = VOICE_IO.sampleRate;

export type ToneResult = {
  id: string;
  how: string;
  sent: string;
  sec: number;
  voicedSec: number;
  loudness: number;
  heard: string;
  wav: string | null;
  error: string | null;
};

function measure(pcm: Buffer) {
  const n = Math.floor(pcm.length / 2);
  const win = RATE / 10;
  const levels: number[] = [];
  for (let i = 0; i + win <= n; i += win) {
    let sum = 0;
    for (let j = 0; j < win; j++) {
      const v = pcm.readInt16LE((i + j) * 2) / 32768;
      sum += v * v;
    }
    levels.push(Math.sqrt(sum / win));
  }
  const voiced = levels.filter((l) => l > 0.01);
  const loudness = voiced.length ? voiced.reduce((a, b) => a + b, 0) / voiced.length : 0;
  return { sec: +(n / RATE).toFixed(2), voicedSec: +(voiced.length / 10).toFixed(1), loudness: Math.round(loudness * 1000) };
}

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function readOnce(token: string, text: string): Promise<Buffer> {
  const res = await fetch(VOICE_IO.ttsUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(ttsRequestBody(text, VOICE_IO.language, 1)),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`tts ${res.status} ${(await res.text()).slice(0, 160)}`);
  return Buffer.from(await res.arrayBuffer());
}

function readLive(token: string, parts: string[]): Promise<Buffer> {
  const params = new URLSearchParams({
    language: VOICE_IO.language,
    voice: VOICE_IO.voice,
    codec: VOICE_IO.codec,
    sample_rate: String(RATE),
    text_normalization: "true",
    optimize_streaming_latency: "1",
    speed: "1",
  });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new WebSocket(`${VOICE_IO.ttsWsUrl}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("tts ws timeout"));
    }, 45_000);
    socket.on("open", async () => {
      for (const delta of parts) {
        socket.send(JSON.stringify({ type: "text.delta", delta }));
        await new Promise((r) => setTimeout(r, 300));
      }
      socket.send(JSON.stringify({ type: "text.done" }));
    });
    socket.on("message", (raw: WebSocket.RawData) => {
      const event = JSON.parse(String(raw)) as { type?: string; delta?: string; message?: string };
      if (event.type === "audio.delta" && event.delta) chunks.push(Buffer.from(event.delta, "base64"));
      if (event.type === "audio.done" || event.type === "error") {
        clearTimeout(timer);
        socket.close();
        if (event.type === "error") reject(new Error(`tts ws ${event.message ?? "error"}`));
        else resolve(Buffer.concat(chunks));
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function hear(token: string, pcm: Buffer): Promise<string> {
  const form = new FormData();
  form.append("model", "grok-voice-transcribe-2.0");
  form.append("filler_words", "true");
  form.append("file", new Blob([new Uint8Array(wav(pcm))], { type: "audio/wav" }), "tone.wav");
  const res = await fetch(VOICE_IO.sttUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) return `（听写失败 ${res.status}）`;
  const body = (await res.json()) as { text?: string; transcript?: string };
  return body.text || body.transcript || "";
}

export const checkSpeechTag = createServerFn({ method: "POST" })
  .validator((input: { password: string; id: string }) => input)
  .handler(async ({ data }): Promise<ToneResult> => {
    assertLab(data.password);
    const c = TONE_CASES.find((x) => x.id === data.id);
    if (!c) throw new Error("没有这个标签");
    const cred = (await xaiCreds())[0];
    if (!cred) throw new Error("没有 xAI 凭证");
    const sent = c.parts.join(" ┃ ");
    try {
      const pcm = c.mode === "http" ? await readOnce(cred.token, c.parts[0]!) : await readLive(cred.token, c.parts);
      return { id: c.id, how: c.how, sent, ...measure(pcm), heard: await hear(cred.token, pcm), wav: wav(pcm).toString("base64"), error: null };
    } catch (err) {
      return { id: c.id, how: c.how, sent, sec: 0, voicedSec: 0, loudness: 0, heard: "", wav: null, error: String(err) };
    }
  });

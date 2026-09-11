import type { ChatMessage, Memory, Profile } from "./types";

export type TalkStreamEvent =
  | { t: "text"; d: string }
  | { t: "text_end"; speech: string }
  | { t: "audio"; i: number; b: string; m: string }
  | { t: "done"; speech: string }
  | { t: "err"; m: string };

export type TalkClientInput = {
  text: string;
  profile: Profile;
  history: ChatMessage[];
  memories: Memory[];
  nowMs?: number;
  timeZone?: string;
};

export async function streamTalk(
  input: TalkClientInput,
  onEvent: (event: TalkStreamEvent) => void,
  signal?: AbortSignal,
) {
  const res = await fetch("/api/talk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    onEvent({ t: "err", m: "这会儿连不上。" });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const audioWait: TalkStreamEvent[] = [];
  let audioTimer = 0;

  const flushAudio = () => {
    audioTimer = 0;
    const batch = audioWait.splice(0);
    for (const event of batch) onEvent(event);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((item) => item.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let event: TalkStreamEvent;
      try {
        event = JSON.parse(payload) as TalkStreamEvent;
      } catch {
        continue;
      }
      if (event.t === "audio") {
        audioWait.push(event);
        if (!audioTimer) audioTimer = window.setTimeout(flushAudio, 0);
        continue;
      }
      onEvent(event);
    }
  }
  if (audioTimer) window.clearTimeout(audioTimer);
  flushAudio();
}

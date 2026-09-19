import { shouldDropAsNoise } from "./noise.ts";

export const UNRECOGNIZED_TEXT = "〔未识别〕";

export type HeardUtterance = {
  text: string;
  turnId: string;
  clipId?: string;
  saveError?: string;
  skipQingran: boolean;
};

export function clipSaveBanner(error: string): string {
  return `录音没存上：${error}`;
}

export function errorText(err: unknown): string {
  if (err && typeof err === "object") {
    const row = err as { message?: string; code?: string; detail?: string };
    const parts = [row.message, row.code ? `code=${row.code}` : "", row.detail]
      .map((part) => (part ?? "").trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" · ");
  }
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? "unknown");
}

export function heardFromHearing(input: {
  debugHearing: boolean;
  turnId: string;
  tagged: string;
  xaiText: string;
  noiseOnly: boolean;
  clipId?: string;
  saveError?: string;
}): HeardUtterance {
  const recognized = input.tagged.trim() || input.xaiText.trim();
  const empty = !recognized || shouldDropAsNoise(input.noiseOnly, input.xaiText);
  if (input.debugHearing) {
    return {
      text: empty ? UNRECOGNIZED_TEXT : recognized,
      turnId: input.turnId,
      clipId: input.clipId,
      saveError: input.saveError,
      skipQingran: empty,
    };
  }
  return {
    text: empty ? "" : recognized,
    turnId: input.turnId,
    clipId: input.clipId,
    saveError: input.saveError,
    skipQingran: false,
  };
}

export function voiceTurnIdForMessage(heard: Pick<HeardUtterance, "clipId" | "turnId">): string | undefined {
  return heard.clipId ? heard.turnId : undefined;
}

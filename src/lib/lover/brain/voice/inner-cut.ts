/** Hidden tail the reply model writes after the spoken line. Rosie never sees it. */
export const INNER_MARK = "⟦心⟧";

const REQUIRED_INNER_KEYS = [
  "desire",
  "read_her",
  "feel",
  "choice",
  "now",
  "scene",
  "longings",
  "plans",
  "glow",
  "next_reach",
] as const;

/**
 * Pull spoken text out of a token stream. The mark can be split across chunks.
 * Anything from the mark onward stays in `tail` and must not be shown or spoken.
 */
export class InnerCutBuffer {
  speech = "";
  tail = "";
  seen = false;
  private hold = "";

  /** Text that is safe to show and to send to TTS. Empty when the chunk is only a mark prefix or tail. */
  push(token: string): string {
    if (!token) return "";
    if (this.seen) {
      this.tail += token;
      return "";
    }
    const chunk = this.hold + token;
    this.hold = "";
    const at = chunk.indexOf(INNER_MARK);
    if (at >= 0) {
      const before = chunk.slice(0, at);
      this.speech += before;
      this.seen = true;
      this.tail = chunk.slice(at + INNER_MARK.length);
      return before;
    }
    const keep = suffixPrefixLen(chunk, INNER_MARK);
    const visible = chunk.slice(0, chunk.length - keep);
    this.hold = chunk.slice(chunk.length - keep);
    this.speech += visible;
    return visible;
  }

  /** Flush a held prefix that never became the mark. Returns text to show. */
  finish(): string {
    if (this.seen || !this.hold) return "";
    const rest = this.hold;
    this.hold = "";
    this.speech += rest;
    return rest;
  }
}

function suffixPrefixLen(text: string, mark: string): number {
  const max = Math.min(mark.length - 1, text.length);
  for (let n = max; n > 0; n -= 1) {
    if (mark.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

/** Mark with nothing spoken before it. The reply failed; do not keep the JSON. */
export function replyBodyMissing(speech: string, seen: boolean): boolean {
  return seen && !speech.trim();
}

export function parseInnerPayload(
  tail: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: "parse" | "missing" } {
  const start = tail.indexOf("{");
  if (start < 0) return { ok: false, reason: "parse" };
  const slice = extractJsonObject(tail.slice(start));
  if (!slice) return { ok: false, reason: "parse" };
  let value: unknown;
  try {
    value = JSON.parse(slice);
  } catch {
    return { ok: false, reason: "parse" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "parse" };
  const row = value as Record<string, unknown>;
  if (REQUIRED_INNER_KEYS.some((key) => !(key in row))) return { ok: false, reason: "missing" };
  return { ok: true, value: row };
}

function extractJsonObject(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}

/** Hidden tail the reply model might still write. Rosie never sees it, and it is not parsed. */
export const INNER_MARK = "⟦心⟧";

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

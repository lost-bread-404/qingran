/**
 * ｛…｝ in a reply is what 清然 thinks and keeps to himself (a game answer, his hand, what he is up to).
 * It is cut from what Rosie sees and hears, anywhere in the reply, and kept in `inner` to be saved as a memory.
 * Full-width braces only: the ASCII {A|B} form is how her own misheard words are marked.
 */
export class BraceCut {
  inner: string[] = [];
  private open = false;
  private current = "";

  push(token: string): string {
    let out = "";
    for (const ch of token) {
      if (this.open) {
        if (ch === "｝") {
          this.open = false;
          if (this.current.trim()) this.inner.push(this.current.trim());
          this.current = "";
        } else {
          this.current += ch;
        }
      } else if (ch === "｛") {
        this.open = true;
      } else {
        out += ch;
      }
    }
    return out;
  }

  /** An unclosed ｛ at the end still counts as his. */
  finish(): void {
    if (this.open && this.current.trim()) this.inner.push(this.current.trim());
    this.open = false;
    this.current = "";
  }

  text(): string {
    return this.inner.join("\n");
  }
}

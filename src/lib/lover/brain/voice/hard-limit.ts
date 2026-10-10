/**
 * Her hard rule (10/10): 清然 never says she is wet. It was in her 亲密设定 and he kept saying it anyway (the words
 * pull the genre, and a written "don't" did not hold), so it is enforced here, not asked for: a clause of his with
 * 「湿」 in it is taken out before she sees it, hears it, or it is saved. Other reactions (发抖、往后缩) stay his to
 * write. This also takes out a non-sexual 湿 (淋湿、眼眶湿了); she chose that over hearing it in bed.
 *
 * Works on a stream: text goes out a clause at a time (up to ，。！？… and the quotes/tags that close it). A clause
 * ending in ，/、 waits for the next one, so 「小猫，姐姐要你湿透。」 comes out as 「小猫。」 rather than 「小猫，」.
 */
export const HARD_LIMIT = /湿/;

const SOFT = "，,、";
const RUN = "，,。．！!？?；;…～~\n";
const CLOSER = "”’\"」』）)】》";
/** What a cut clause leaves behind so pairs stay balanced: speech tags and quotes/brackets, never words. */
const MARKUP = /<\/?[A-Za-z][A-Za-z0-9-]*>|[“”‘’"「」『』（）()【】《》*]/g;
const CLOSE_TAG = /^<\/[A-Za-z][A-Za-z0-9-]*>/;
/** A tag still being written ("<", "</so", "<sof"). */
const PART_TAG = /^<\/?[A-Za-z0-9-]*$/;

type Clause = { text: string; runAt: number; runLen: number; soft: boolean; softLen: number };

export class HardLimit {
  /** The clauses taken out, for the replay card. */
  cut: string[] = [];
  private buf = "";
  /** A clause ending soft, waiting to see the next one. */
  private held = "";
  private softAt = -1;
  private softLen = 0;
  /** `held` carries what a cut left behind (may need tidying, may end with a cut soft clause). */
  private dirty = false;

  push(token: string): string {
    this.buf += token;
    let out = "";
    for (;;) {
      const clause = this.take(false);
      if (!clause) break;
      out += this.feed(clause);
    }
    return out;
  }

  finish(): string {
    let out = "";
    for (;;) {
      const clause = this.take(true);
      if (!clause) break;
      out += this.feed(clause);
    }
    if (this.held) {
      // The reply ended on a cut soft clause: the one before it ends the sentence.
      let text = this.held;
      if (this.dirty && this.softAt >= 0) text = text.slice(0, this.softAt) + "。" + text.slice(this.softAt + this.softLen);
      out += this.dirty ? tidy(text) : text;
    }
    this.held = "";
    this.softAt = -1;
    this.dirty = false;
    return out;
  }

  /** One finished clause from the buffer: text, its punctuation run, then closers (quotes, closing tags, spaces). */
  private take(final: boolean): Clause | null {
    const s = this.buf;
    if (!s) return null;
    let i = 0;
    while (i < s.length && !RUN.includes(s[i]!)) i += 1;
    if (i >= s.length) {
      if (!final) return null;
      this.buf = "";
      return { text: s, runAt: s.length, runLen: 0, soft: false, softLen: 0 };
    }
    const runAt = i;
    while (i < s.length && RUN.includes(s[i]!)) i += 1;
    const runLen = i - runAt;
    for (;;) {
      if (i < s.length && (CLOSER.includes(s[i]!) || s[i] === " ")) {
        i += 1;
        continue;
      }
      const tag = CLOSE_TAG.exec(s.slice(i));
      if (tag) {
        i += tag[0].length;
        continue;
      }
      break;
    }
    // Closers may still be coming: a clause is done only when something else follows it (or the reply ends).
    if (!final && (i >= s.length || PART_TAG.test(s.slice(i)))) return null;
    const text = s.slice(0, i);
    this.buf = s.slice(i);
    const run = s.slice(runAt, runAt + runLen);
    const punct = run.match(/^[^\n]*/)![0];
    const soft = punct.length > 0 && /^\n*$/.test(run.slice(punct.length)) && [...punct].every((ch) => SOFT.includes(ch));
    return { text, runAt, runLen, soft, softLen: soft ? punct.length : 0 };
  }

  private feed(c: Clause): string {
    const body = c.text.slice(0, c.runAt);
    if (HARD_LIMIT.test(body)) {
      this.cut.push(body.replace(MARKUP, "").trim());
      const residue = (body.match(MARKUP) ?? []).join("") + (c.text.slice(c.runAt + c.runLen).match(MARKUP) ?? []).join("");
      if (c.soft) {
        this.held += residue;
        this.dirty = true;
        return "";
      }
      // The sentence ended with the cut clause: the clause before it takes its full stop.
      const run = c.text.slice(c.runAt, c.runAt + c.runLen).replace(/\n/g, "") || "。";
      let text = this.held;
      if (this.softAt >= 0) text = text.slice(0, this.softAt) + run + text.slice(this.softAt + this.softLen);
      text += residue;
      // A paragraph break after the cut sentence stays when there is something before it on that line.
      if (text.trim() && !/\n\s*$/.test(text) && /\n\s*$/.test(c.text)) text += c.text.slice(c.text.trimEnd().length);
      this.held = "";
      this.softAt = -1;
      this.dirty = false;
      return tidy(text);
    }
    if (c.soft) {
      const out = this.held ? (this.dirty ? tidy(this.held) : this.held) : "";
      this.held = c.text;
      this.softAt = c.runAt;
      this.softLen = c.softLen;
      this.dirty = false;
      return out;
    }
    const text = this.held + c.text;
    const dirty = this.dirty;
    this.held = "";
    this.softAt = -1;
    this.dirty = false;
    return dirty ? tidy(text) : text;
  }
}

/** Empty pairs a cut leaves behind (「」, “”, <soft></soft>). Only run on text a cut touched. */
export function tidy(text: string): string {
  let prev = "";
  let out = text;
  while (out !== prev) {
    prev = out;
    out = out
      .replace(/<([a-zA-Z][a-zA-Z0-9-]*)>\s*<\/\1>/g, "")
      .replace(/“\s*”|‘\s*’|「\s*」|『\s*』|（\s*）|\(\s*\)|【\s*】|《\s*》/g, "");
  }
  return out;
}

/** A whole reply at once (a message he starts, a replay, his past lines in the context). */
export function applyHardLimit(text: string): { text: string; cut: string[] } {
  if (!HARD_LIMIT.test(text)) return { text: text.trim(), cut: [] };
  const limit = new HardLimit();
  const out = limit.push(text) + limit.finish();
  return { text: out.trim(), cut: limit.cut };
}

import { VOICE_IO } from "./brain/config";

/**
 * Other people in the scene. One model plays everyone; a block that starts with 「林泽：」 is 林泽 until another
 * name starts a block (「清然：」 goes back to him). Without a name it is 清然. Each person's block (his actions,
 * what he sees, what he says, in his own first person) is read in his voice; 清然 is Eve.
 * Only the names in her table (设置 → 声音和听力 → 角色声线) start a block, so 「我说：」 inside his line never does.
 */
export const LEAD = "清然";

/** name → xAI voice */
export type Cast = Record<string, string>;

export type CastPart = { who: string; voice: string; text: string };

/** One person per line: 「林泽 lux」 (also 「林泽：lux」 or 「林泽=lux」). */
export function parseCast(text: string | undefined | null): Cast {
  const cast: Cast = {};
  for (const line of String(text ?? "").split("\n")) {
    const m = line.trim().match(/^(.{1,12}?)\s*[\s:：=]\s*([A-Za-z][\w-]{0,31})$/);
    if (m && m[1] && m[2]) cast[m[1].trim()] = m[2].toLowerCase();
  }
  return cast;
}

export function voiceOf(who: string, cast: Cast): string {
  return cast[who] ?? VOICE_IO.voice;
}

function namesOf(cast: Cast): string[] {
  return [...new Set([LEAD, ...Object.keys(cast)])].sort((a, b) => b.length - a.length);
}

/** Leading spaces and markdown bold before a name. */
const LINE_LEAD = /^[\s*]*/;

/** The name a line starts with (and how long the label is), if it is one of hers. */
function labelOf(line: string, names: string[]): { who: string; length: number } | null {
  const lead = line.match(LINE_LEAD)?.[0].length ?? 0;
  const rest = line.slice(lead);
  for (const name of names) {
    const m = rest.match(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*{0,2}\\s*[：:][*\\s]*`));
    if (m) return { who: name, length: lead + m[0].length };
  }
  return null;
}

/** Could this line start still turn into a label once more text comes? */
function mayBeLabel(head: string, names: string[]): boolean {
  const rest = head.replace(LINE_LEAD, "");
  if (!rest) return true;
  return names.some((name) => name.startsWith(rest) || (rest.startsWith(name) && /^\*{0,2}\s*$/.test(rest.slice(name.length))));
}

function merge(parts: CastPart[]): CastPart[] {
  const out: CastPart[] = [];
  for (const p of parts) {
    if (!p.text) continue;
    const last = out[out.length - 1];
    if (last && last.who === p.who) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/** The streaming cut: text in as it is written, each person's part out, labels removed. */
export class SpeakerCut {
  private names: string[];
  private who = LEAD;
  private head = "";
  private atLineStart = true;

  constructor(private cast: Cast) {
    this.names = namesOf(cast);
  }

  private part(text: string): CastPart {
    return { who: this.who, voice: voiceOf(this.who, this.cast), text };
  }

  push(token: string): CastPart[] {
    const out: CastPart[] = [];
    let body = "";
    for (const ch of token) {
      if (!this.atLineStart) {
        body += ch;
        if (ch === "\n") this.atLineStart = true;
        continue;
      }
      this.head += ch;
      if (ch === "\n") {
        // 「林泽：」 alone on its line: his block starts on the next line.
        const own = labelOf(this.head.slice(0, -1), this.names);
        if (own && own.length >= this.head.length - 1) {
          if (body) out.push(this.part(body));
          body = "";
          this.who = own.who;
        } else {
          body += this.head;
        }
        this.head = "";
        continue;
      }
      const label = labelOf(this.head, this.names);
      // A label is complete once something other than its colon, space or bold follows it.
      if (label && label.length < this.head.length) {
        if (body) out.push(this.part(body));
        body = "";
        this.who = label.who;
        body = this.head.slice(label.length);
        this.head = "";
        this.atLineStart = false;
        continue;
      }
      if (label || mayBeLabel(this.head, this.names)) continue;
      body += this.head;
      this.head = "";
      this.atLineStart = false;
    }
    if (body) out.push(this.part(body));
    return merge(out);
  }

  finish(): CastPart[] {
    const head = this.head;
    this.head = "";
    if (!head) return [];
    const label = labelOf(head, this.names);
    if (label) {
      this.who = label.who;
      return merge([this.part(head.slice(label.length))]);
    }
    return [this.part(head)];
  }
}

/** A whole reply, cut by person. */
export function splitSpeakers(text: string, cast: Cast): CastPart[] {
  const cut = new SpeakerCut(cast);
  return merge([...cut.push(text), ...cut.finish()]).filter((p) => p.text.trim());
}

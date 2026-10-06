import { VOICE_IO } from "./brain/config";
import type { Profile } from "./types";

/**
 * Other people in the scene. One model plays everyone; a block that starts with 「林泽：」 is 林泽 until another
 * name starts a block (「清然：」 goes back to him) or the paragraph ends (an empty line). Without a name it is 清然. Each person's block (his actions,
 * what he sees, what he says, in his own first person) is read in his voice; 清然 is Eve.
 * Any short name at the start of a line followed by a colon starts a block (a waiter nobody named in advance too);
 * 「我说：」「他说：」 never do. Someone she added (设置 → 人设) is read in the voice she picked for him; anyone else in
 * her 「其他人」 voice.
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

/** The table line that gives everyone not named in it a voice: 「其他人 ara」. */
export const OTHERS = "其他人";

/** Her 人设 page as a cast: 清然, each character she added, everyone else. */
export function castOf(profile: Pick<Profile, "leadVoice" | "characters" | "othersVoice"> & { castOn?: boolean }): Cast {
  // 其他角色 off (v7): everything is read in 清然's voice.
  if (!profile.castOn) return { [LEAD]: profile.leadVoice, [OTHERS]: profile.leadVoice };
  const cast: Cast = { [LEAD]: profile.leadVoice, [OTHERS]: profile.othersVoice };
  for (const c of profile.characters) cast[c.name] = c.voice;
  return cast;
}

export function voiceOf(who: string, cast: Cast): string {
  if (who === LEAD) return cast[LEAD] ?? VOICE_IO.voice;
  return cast[who] ?? cast[OTHERS] ?? VOICE_IO.voice;
}

/** A name nobody put in the table: 2–6 Han characters, or a Latin name; not a pronoun (「我说：」「她们：」). */
const ANY_NAME = /^(?:[\p{Script=Han}]{2,6}|[A-Za-z][A-Za-z .'-]{0,15})/u;
const PRONOUN = /^[我你您她他它咱]/;

function namesOf(cast: Cast): string[] {
  return [...new Set([LEAD, ...Object.keys(cast)])].sort((a, b) => b.length - a.length);
}

/** Leading spaces and markdown bold before a name. */
const LINE_LEAD = /^[\s*]*/;

/** The name a line starts with (and how long the label is): one in her table first, then any short name. */
function labelOf(line: string, names: string[]): { who: string; length: number } | null {
  const lead = line.match(LINE_LEAD)?.[0].length ?? 0;
  const rest = line.slice(lead);
  for (const name of names) {
    const m = rest.match(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*{0,2}\\s*[：:][*\\s]*`));
    if (m) return { who: name, length: lead + m[0].length };
  }
  const any = rest.match(ANY_NAME)?.[0];
  if (!any || PRONOUN.test(any)) return null;
  const m = rest.slice(any.length).match(/^\*{0,2}\s*[：:][*\s]*/);
  return m ? { who: any.trim(), length: lead + any.length + m[0].length } : null;
}

/** Could this line start still turn into a label once more text comes? */
function mayBeLabel(head: string, names: string[]): boolean {
  const rest = head.replace(LINE_LEAD, "");
  if (!rest) return true;
  if (names.some((name) => name.startsWith(rest) || (rest.startsWith(name) && /^\*{0,2}\s*$/.test(rest.slice(name.length))))) {
    return true;
  }
  // Up to six Han characters (or a short Latin name), maybe bold, with no colon yet.
  return !PRONOUN.test(rest) && /^(?:[\p{Script=Han}]{1,6}|[A-Za-z][A-Za-z .'-]{0,15})\*{0,2}\s*$/u.test(rest);
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
  /** A name was just taken and nothing of his has been written yet (「**林泽：**」, an empty line, then his paragraph). */
  private waiting = false;

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
        if (ch.trim()) this.waiting = false;
        if (ch === "\n") this.atLineStart = true;
        continue;
      }
      this.head += ch;
      if (ch === "\n" && !this.head.slice(0, -1).trim()) {
        // An empty line ends a paragraph. Another person's block is one paragraph: what comes after it without a
        // name is 清然 again (10/5: 清然 went on after 林泽's line without writing 「清然：」 and was read in 林泽's voice).
        body += this.head;
        this.head = "";
        if (this.who !== LEAD && !this.waiting) {
          out.push(this.part(body));
          body = "";
          this.who = LEAD;
        }
        continue;
      }
      if (ch === "\n") {
        // 「林泽：」 alone on its line: his block starts on the next line.
        const own = labelOf(this.head.slice(0, -1), this.names);
        if (own && own.length >= this.head.length - 1) {
          if (body) out.push(this.part(body));
          body = "";
          this.who = own.who;
          this.waiting = true;
        } else {
          if (this.head.trim()) this.waiting = false;
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
        this.waiting = !body.trim();
        this.head = "";
        this.atLineStart = false;
        continue;
      }
      if (label || mayBeLabel(this.head, this.names)) continue;
      if (this.head.trim()) this.waiting = false;
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

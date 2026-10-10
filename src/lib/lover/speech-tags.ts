/**
 * The speech tags xAI's voice reads (docs.x.ai text-to-speech): inline ones stand alone in square brackets
 * ([laugh]), wrapping ones go round words in angle brackets (<whisper>…</whisper>). The lab page tries every one.
 */
export const INLINE_TAGS = [
  "pause", "long-pause", "hum-tune", "laugh", "chuckle", "giggle", "cry",
  "tsk", "tongue-click", "lip-smack", "breath", "inhale", "exhale", "sigh",
] as const;
export const WRAP_TAGS = [
  "soft", "whisper", "loud", "build-intensity", "decrease-intensity",
  "higher-pitch", "lower-pitch", "slow", "fast", "sing-song", "singing", "emphasis",
] as const;
const INLINE_SET = new Set<string>(INLINE_TAGS);
const WRAP_SET = new Set<string>(WRAP_TAGS);

const INLINE = new RegExp(`\\[(${INLINE_TAGS.join("|")})\\]`, "gi");
/** Any other [word] or <tag> the model invents, and a tag cut in half at the end of a capped reply (「</emphasi」). */
const ANY_INLINE = /\[[A-Za-z][A-Za-z -]{0,24}\]/g;
const ANY_WRAP = /<\/?[A-Za-z][A-Za-z-]{0,24}\s*>/g;
const CUT_TAG = /(?:<\/?\s*[A-Za-z-]*\s*|\[[A-Za-z -]*)$/;
/** His notes, full-width ｛｝ or ASCII {} (Grok writes both), closed or running to the end of the reply. */
const NOTES = /[｛{][^｛{｝}]*(?:[｝}]|$)/g;

/**
 * What Rosie sees of one of his replies: no voice tags, no notes. Every place that shows his words uses this
 * (chat, notifications), so a reply stored with them, or cut in the middle of one, never shows them.
 */
export function stripSpeechTags(text: string): string {
  return cleanSpeechTags(text.replace(NOTES, ""))
    .replace(INLINE, (tag) => (/pause/i.test(tag) ? "\n" : " "))
    .replace(ANY_INLINE, " ")
    .replace(ANY_WRAP, "")
    .replace(CUT_TAG, "")
    .replace(/[*_`#]+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Only the tags Eve can read, in the bracket they belong in. A tag the model made up ([soft], <sad>, [laugh softly])
 * would be read out as words, and left in his past replies it gets copied into every reply after it (10/8). So it is
 * dropped at every way out: what is read aloud (live and replay) and what he sees of his own replies.
 * A tag cut off at the end (「</emphasi」) goes too.
 */
export function cleanSpeechTags(text: string): string {
  return text
    .replace(/\[\s*([A-Za-z][A-Za-z -]{1,24}?)\s*\]/g, (_, name: string) => {
      const n = name.toLowerCase();
      return INLINE_SET.has(n) ? `[${n}]` : "";
    })
    .replace(/<(\/\s*)?([A-Za-z][A-Za-z-]{0,24})\s*>/g, (_, close: string | undefined, name: string) => {
      const n = name.toLowerCase();
      return WRAP_SET.has(n) ? `<${close ? "/" : ""}${n}>` : "";
    })
    .replace(CUT_TAG, "")
    .replace(/[ \t]{2,}/g, " ");
}

/** A piece of a reply still being written ends inside a tag: hold it until the tag is whole. */
export function endsInOpenTag(text: string): boolean {
  return CUT_TAG.test(text);
}

export function spokenForTts(text: string): string {
  let spoken = cleanSpeechTags(text.replace(/\r/g, "")).trim();
  spoken = spoken.replace(/[「」『』“”""]/g, "");
  spoken = spoken.replace(/\n+/g, " ");
  spoken = spoken.replace(/[ \t]{2,}/g, " ").trim();
  if (spoken.length > 1400) spoken = `${spoken.slice(0, 1400).trim()}`;
  return spoken;
}

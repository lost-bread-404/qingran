const INLINE =
  /\[(pause|long-pause|hum-tune|laugh|chuckle|giggle|cry|tsk|tongue-click|lip-smack|breath|inhale|exhale|sigh)\]/gi;
/** Any other [word] or <tag> the model invents, and a tag cut in half at the end of a capped reply (「</emphasi」). */
const ANY_INLINE = /\[[A-Za-z][A-Za-z -]{0,24}\]/g;
const ANY_WRAP = /<\/?[A-Za-z][A-Za-z-]{0,24}\s*>/g;
const CUT_TAG = /(?:<\/?[A-Za-z-]*|\[[A-Za-z -]*)$/;
/** His notes, full-width ｛｝ or ASCII {} (Grok writes both), closed or running to the end of the reply. */
const NOTES = /[｛{][^｛{｝}]*(?:[｝}]|$)/g;

/**
 * What Rosie sees of one of his replies: no voice tags, no notes. Every place that shows his words uses this
 * (chat, notifications), so a reply stored with them, or cut in the middle of one, never shows them.
 */
export function stripSpeechTags(text: string): string {
  return text
    .replace(NOTES, "")
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

export function spokenForTts(text: string): string {
  let spoken = text.replace(/\r/g, "").trim();
  spoken = spoken.replace(/[「」『』“”""]/g, "");
  spoken = spoken.replace(/\n+/g, " ");
  spoken = spoken.replace(/[ \t]{2,}/g, " ").trim();
  if (spoken.length > 1400) spoken = `${spoken.slice(0, 1400).trim()}`;
  return spoken;
}

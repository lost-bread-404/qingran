const INLINE =
  /\[(pause|long-pause|hum-tune|laugh|chuckle|giggle|cry|tsk|tongue-click|lip-smack|breath|inhale|exhale|sigh)\]/gi;
const WRAP =
  /<\/?(soft|whisper|loud|build-intensity|decrease-intensity|higher-pitch|lower-pitch|slow|fast|sing-song|singing|emphasis)>/gi;

export function stripSpeechTags(text: string): string {
  return text
    .replace(INLINE, (tag) => (/pause/i.test(tag) ? "\n" : " "))
    .replace(WRAP, "")
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
  spoken = spoken.replace(/\n{2,}/g, " [pause] ");
  spoken = spoken.replace(/\n+/g, " ");
  spoken = spoken.replace(/[ \t]{2,}/g, " ").trim();
  if (spoken.length > 1400) spoken = `${spoken.slice(0, 1400).trim()}`;
  return spoken;
}

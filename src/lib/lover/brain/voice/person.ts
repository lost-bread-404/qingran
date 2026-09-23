/**
 * Rewrite stored third-person notes into 清然's voice for the reply model.
 * Database text is not modified. Idempotent on text that is already first person.
 *
 * Rosie → 你, 清然 → 我, 她 → 你. 她们 is left alone (other people stay 他).
 * A space between the name and Chinese is dropped, so 「Rosie 今天」becomes「你今天」.
 */
export function asQingranFirstPerson(text: string): string {
  if (!text) return text;
  const plural = "\u0000PLURAL\u0000";
  let next = text.replaceAll("她们", plural);
  next = next.replace(/\bRosie(?:'s|’s)?\b/gi, (match) => (/s$/i.test(match) ? "你的" : "你"));
  next = next.replaceAll("清然", "我");
  next = next.replaceAll("她", "你");
  next = next.replaceAll(plural, "她们");
  return next
    .replace(/([\u4e00-\u9fff])[ \t]+([你我])/g, "$1$2")
    .replace(/([你我]的?)[ \t]+([\u4e00-\u9fff])/g, "$1$2");
}

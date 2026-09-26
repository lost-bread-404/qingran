export function similar(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length < 8) return false;
  let hits = 0;
  const used = new Set<number>();
  for (const ch of short) {
    const idx = [...long].findIndex((c, i) => c === ch && !used.has(i));
    if (idx >= 0) {
      used.add(idx);
      hits += 1;
    }
  }
  return hits / short.length >= 0.78;
}

function norm(s: string): string {
  return s.replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, "").toLowerCase();
}

export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const startObj = trimmed.indexOf("{");
  const endObj = trimmed.lastIndexOf("}");
  if (startObj >= 0 && endObj > startObj) return trimmed.slice(startObj, endObj + 1);
  const startArr = trimmed.indexOf("[");
  const endArr = trimmed.lastIndexOf("]");
  if (startArr >= 0 && endArr > startArr) return trimmed.slice(startArr, endArr + 1);
  return trimmed;
}

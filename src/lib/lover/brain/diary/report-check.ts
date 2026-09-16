function extractNumbers(text: string): string[] {
  return text.match(/-?\d+(?:\.\d+)?/g) ?? [];
}

function flattenNumbers(data: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof data === "number" && Number.isFinite(data)) {
    out.add(String(data));
    out.add(String(Math.round(data * 100) / 100));
    out.add(data.toFixed(2));
    out.add(data.toFixed(1));
    return out;
  }
  if (Array.isArray(data)) {
    for (const x of data) flattenNumbers(x, out);
    return out;
  }
  if (data && typeof data === "object") {
    for (const v of Object.values(data as Record<string, unknown>)) flattenNumbers(v, out);
  }
  return out;
}

export function narrativeNumbersOk(narrative: string, data: unknown): boolean {
  const allowed = flattenNumbers(data);
  allowed.add("4");
  allowed.add("3");
  allowed.add("5");
  allowed.add("1");
  allowed.add("2");
  allowed.add("0");
  allowed.add("50");
  allowed.add("8");
  allowed.add("6");
  for (const n of extractNumbers(narrative)) {
    if (!allowed.has(n) && !allowed.has(String(Number(n)))) return false;
  }
  return true;
}

export const LOG_ROUTE_FILTERS = [
  ["voice", "回复"],
  ["editor", "夜里整理"],
  ["report", "月报"],
  ["hear", "听力"],
  ["manual", "手改"],
] as const;


export function messagesFromStored(input: unknown): Array<{ role: string; content: string }> | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (Array.isArray(o.messages)) {
    const messages = o.messages
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as { role?: unknown; content?: unknown };
        if (row.content == null) return null;
        return { role: String(row.role || "user"), content: String(row.content) };
      })
      .filter((row): row is { role: string; content: string } => Boolean(row));
    return messages.length ? messages : null;
  }
  const messages: Array<{ role: string; content: string }> = [];
  if (typeof o.system === "string" && o.system) messages.push({ role: "system", content: o.system });
  if (Array.isArray(o.user)) {
    for (const part of o.user) messages.push({ role: "user", content: String(part ?? "") });
  } else if (typeof o.user === "string" && o.user) {
    messages.push({ role: "user", content: o.user });
  }
  if (typeof o.truncated === "boolean" && o.truncated && typeof o.preview === "string") {
    messages.push({ role: "system", content: o.preview });
  }
  return messages.length ? messages : null;
}



export function formatDbBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "未知";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Messages as one plain text, exactly as sent, each under its role. */
export function messagesText(messages: Array<{ role: string; content: string }>): string {
  return messages.map((message) => `── ${message.role} ──\n${message.content}`).join("\n\n");
}

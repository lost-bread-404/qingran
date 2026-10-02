/**
 * Vectors of meaning for his memories (docs/brain.md「怎么想起来」). Any OpenAI-compatible /embeddings endpoint:
 * EMBED_BASE_URL (ending in /v1), EMBED_API_KEY, EMBED_MODEL. Without them, the Neon AI Gateway of the branch
 * (NEON_AI_GATEWAY_BASE_URL + NEON_AI_GATEWAY_TOKEN, model qwen3-embedding-0-6b). Without either, or when a call
 * fails or is refused, memory falls back to words alone — he still remembers, never stalls.
 */
export type EmbedConfig = { url: string; key: string; model: string };

export function embedConfig(): EmbedConfig | null {
  const url = (process.env.EMBED_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = (process.env.EMBED_API_KEY ?? "").trim();
  if (url && key) return { url, key, model: (process.env.EMBED_MODEL ?? "").trim() || "text-embedding-3-small" };
  const neon = (process.env.NEON_AI_GATEWAY_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.NEON_AI_GATEWAY_TOKEN ?? "").trim();
  if (neon && token) return { url: `${neon}/v1`, key: token, model: (process.env.EMBED_MODEL ?? "").trim() || "qwen3-embedding-0-6b" };
  return null;
}

/** One call for up to this many texts. */
const BATCH = 32;

/** Vectors for `texts` in order, or null if the endpoint is missing, slow, refuses or fails. */
export async function embedTexts(texts: string[], timeoutMs = 20_000): Promise<number[][] | null> {
  const config = embedConfig();
  if (!config || !texts.length) return null;
  const out: number[][] = [];
  try {
    for (let i = 0; i < texts.length; i += BATCH) {
      const res = await fetch(`${config.url}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
        body: JSON.stringify({ model: config.model, input: texts.slice(i, i + BATCH).map((t) => t.slice(0, 4000)), encoding_format: "float" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        console.error(`[embed] ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
        return null;
      }
      const json = (await res.json()) as { data?: Array<{ embedding?: unknown; index?: number }> };
      const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const row of rows) {
        if (!Array.isArray(row.embedding)) return null;
        out.push(row.embedding.map(Number));
      }
    }
  } catch (err) {
    console.error("[embed]", err instanceof Error ? err.message : err);
    return null;
  }
  return out.length === texts.length ? out : null;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let x = 0;
  let y = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    x += a[i]! * a[i]!;
    y += b[i]! * b[i]!;
  }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}

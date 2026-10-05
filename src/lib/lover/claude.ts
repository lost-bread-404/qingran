import type { XaiMessage } from "./photos.ts";

/**
 * Claude, straight from the Anthropic API. Key: ANTHROPIC_API_KEY.
 * The chat messages the rest of the program builds (system / user / assistant, photos as data URLs) are turned into
 * Anthropic's shape here; the words are the same.
 */
export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5"] as const;
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
/** Who wrote a reply: Claude or Grok (by the model). */
export type Engine = "claude" | "grok";
export function engineOf(model: string | null | undefined): Engine {
  return isClaudeModel(model) ? "claude" : "grok";
}

/** Claude's effort levels (Opus 5.5 always thinks; low is the quickest). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const CLAUDE_MODEL_BLURBS: Record<string, string> = {
  "claude-opus-5-5": "Claude 最聪明的一档",
  "claude-sonnet-5-5": "价格是 Opus 的一半，快一些",
  "claude-sonnet-5": "上一代 Sonnet，同价",
};

export function isClaudeModel(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("claude-");
}

/** Thinking counts against the cap, so it is far above the length of a reply. */
export const CLAUDE_MAX_TOKENS = 16_000;
export const CLAUDE_TIMEOUT_MS = 90_000;

type Block =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: { type: "ephemeral" } };
type ClaudeMessage = { role: "user" | "assistant"; content: Block[] };

const DATA_URL = /^data:([^;]+);base64,(.+)$/;

function blocksOf(content: XaiMessage["content"]): Block[] {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  const out: Block[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.trim()) out.push({ type: "text", text: part.text });
      continue;
    }
    const m = DATA_URL.exec(part.image_url.url);
    if (m) out.push({ type: "image", source: { type: "base64", media_type: m[1]!, data: m[2]! } });
  }
  return out;
}

/**
 * The system messages before the talk are the system prompt; a system message inside or after the talk (a pause,
 * 想起来的事, the time) goes in as text on her side, in the same place. Neighbours of one side become one message
 * with several blocks, so a block once sent stays the same block next turn (the cache keeps working).
 * Cached: the system prompt, and everything up to his last reply.
 */
export function claudeBody(
  messages: XaiMessage[],
  model: string,
  opts: { stream: boolean; effort?: string | null; maxTokens?: number },
): Record<string, unknown> {
  const system: Block[] = [];
  let i = 0;
  for (; i < messages.length && messages[i]!.role === "system"; i += 1) system.push(...blocksOf(messages[i]!.content));
  const talk: ClaudeMessage[] = [];
  for (const message of messages.slice(i)) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const blocks = blocksOf(message.content);
    if (!blocks.length) continue;
    const last = talk[talk.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else talk.push({ role, content: blocks });
  }
  // The API wants her side first (only when the talk starts with his message and nothing comes before it).
  if (talk[0]?.role === "assistant") talk.unshift({ role: "user", content: [{ type: "text", text: "……" }] });
  if (system.length) system[system.length - 1]!.cache_control = { type: "ephemeral" };
  const lastReply = talk.map((m) => m.role).lastIndexOf("assistant");
  if (lastReply >= 0) {
    const blocks = talk[lastReply]!.content;
    blocks[blocks.length - 1]!.cache_control = { type: "ephemeral" };
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: Math.max(CLAUDE_MAX_TOKENS, opts.maxTokens ?? 0),
    messages: talk,
    stream: opts.stream,
  };
  if (system.length) body.system = system;
  if (opts.effort === "low" || opts.effort === "medium" || opts.effort === "high" || opts.effort === "xhigh" || opts.effort === "max")
    body.output_config = { effort: opts.effort };
  return body;
}

export async function claudeFetch(body: Record<string, unknown>, timeoutMs = CLAUDE_TIMEOUT_MS): Promise<Response> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no ANTHROPIC_API_KEY");
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Anthropic's usage in the shape the rest of the program reads (parseUsage): input = all prompt tokens,
 * cached = read from the cache, cache_creation_input_tokens = written to it (priced apart).
 */
export function claudeUsage(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const write = n(u.cache_creation_input_tokens);
  const read = n(u.cache_read_input_tokens);
  return {
    input_tokens: n(u.input_tokens) + write + read,
    output_tokens: n(u.output_tokens),
    cached_tokens: read,
    cache_creation_input_tokens: write,
  };
}

/** The visible text of a whole (not streamed) answer: its text blocks. */
export function claudeText(raw: unknown): string {
  const content = raw && typeof raw === "object" ? (raw as { content?: unknown }).content : null;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => Boolean(b) && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("");
}

/** Anthropic's stop reasons in the words the rest of the program uses. */
export function claudeFinish(reason: unknown): string | null {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "max_tokens") return "length";
  return typeof reason === "string" ? reason : null;
}

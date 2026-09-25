import { defaultPrompt, promptSpec, type PromptKey } from "./catalog.ts";
import { fillTemplate } from "./fill.ts";
import type { PromptMessage, PromptRole } from "./templates.ts";

export const HISTORY_SLOT = "{history_messages}";
const INNER_MARK = "⟦心⟧";

export type PromptDoc = {
  v: 2;
  variants: Array<{
    id: string;
    label: string;
    messages: PromptMessage[];
  }>;
};

export type RenderedMessage = {
  role: PromptRole;
  content: string;
};

const ROLES = new Set<PromptRole>(["system", "user", "assistant"]);

export function defaultDoc(key: PromptKey): PromptDoc {
  const spec = promptSpec(key);
  return {
    v: 2,
    variants: spec.variants.map((variant) => ({
      id: variant.id,
      label: variant.label,
      messages: variant.messages.map((message) => ({ role: message.role, content: message.content })),
    })),
  };
}

export function serializeDoc(doc: PromptDoc): string {
  return JSON.stringify({
    v: 2,
    variants: doc.variants.map((variant) => ({
      id: variant.id,
      label: variant.label,
      messages: variant.messages.map((message) => ({
        role: message.role,
        content: message.content.replace(/\r\n/g, "\n"),
      })),
    })),
  });
}

export function personaAckText(body: string | null | undefined): string {
  const messages = variantMessages(parsePromptBody("persona_ack", body), "main");
  const ack = messages.find((message) => message.role === "assistant") ?? messages[0];
  return ack?.content.trim() || "嗯。";
}

export function variantMessages(doc: PromptDoc, variantId: string): PromptMessage[] {
  return (
    doc.variants.find((variant) => variant.id === variantId)?.messages ??
    doc.variants[0]?.messages ??
    []
  );
}

function normalizeDoc(key: PromptKey, doc: PromptDoc): PromptDoc {
  const base = defaultDoc(key);
  const byId = new Map(doc.variants.map((variant) => [variant.id, variant]));
  return {
    v: 2,
    variants: base.variants.map((fallback) => {
      const got = byId.get(fallback.id);
      const messages = (got?.messages ?? []).filter(
        (message): message is PromptMessage =>
          Boolean(message) &&
          ROLES.has(message.role) &&
          typeof message.content === "string",
      );
      return {
        id: fallback.id,
        label: fallback.label,
        messages: messages.length ? messages : fallback.messages.map((message) => ({ ...message })),
      };
    }),
  };
}

/** A saved voice template may still contain the old hidden-tail instructions. Drop them. */
export function stripVoiceStateBlock(doc: PromptDoc): PromptDoc {
  const fallback = defaultDoc("voice");
  let changed = false;
  const variants = doc.variants.map((variant) => {
    const messages = variant.messages
      .map((message) => {
        const content = stripStateTail(message.content);
        if (content !== message.content) changed = true;
        return { ...message, content };
      })
      .filter((message) => message.content.trim());
    if (messages.length !== variant.messages.length) changed = true;
    if (messages.length) return { ...variant, messages };
    changed = true;
    const fresh = fallback.variants.find((item) => item.id === variant.id)?.messages ?? [];
    return { ...variant, messages: fresh.map((message) => ({ ...message })) };
  });
  return changed ? { ...doc, variants } : doc;
}

function stripStateTail(content: string): string {
  const at = content.indexOf(INNER_MARK);
  if (at < 0) return content;
  const lineStart = content.lastIndexOf("\n", at - 1);
  return content.slice(0, lineStart < 0 ? 0 : lineStart).trimEnd();
}

export function parsePromptBody(key: PromptKey, body: string | null | undefined): PromptDoc {
  const fallback = defaultDoc(key);
  const raw = (body ?? "").replace(/\r\n/g, "\n").trim();
  const finish = (doc: PromptDoc) => (key === "voice" ? stripVoiceStateBlock(doc) : doc);
  if (!raw) return finish(fallback);
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<PromptDoc>;
      if (parsed && parsed.v === 2 && Array.isArray(parsed.variants)) {
        return finish(normalizeDoc(key, parsed as PromptDoc));
      }
    } catch {
      /* legacy plain text */
    }
  }
  if (raw === defaultPrompt(key)) return finish(fallback);
  const next = defaultDoc(key);
  for (const variant of next.variants) {
    const systemMessage = variant.messages.find((message) => message.role === "system");
    if (systemMessage) systemMessage.content = raw;
    else if (variant.messages[0]) variant.messages[0].content = raw;
  }
  return finish(next);
}

export function renderPromptMessages(
  messages: PromptMessage[],
  vars: Record<string, string>,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): RenderedMessage[] {
  const out: RenderedMessage[] = [];
  for (const message of messages) {
    if (message.content.trim() === HISTORY_SLOT) {
      out.push(...history);
      continue;
    }
    out.push({ role: message.role, content: fillTemplate(message.content, vars) });
  }
  return out;
}

export function renderVariant(
  doc: PromptDoc,
  variantId: string,
  vars: Record<string, string>,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): RenderedMessage[] {
  return renderPromptMessages(variantMessages(doc, variantId), vars, history);
}

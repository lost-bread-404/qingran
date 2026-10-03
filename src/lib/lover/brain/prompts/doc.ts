import { defaultPrompt, promptSpec, type PromptKey } from "./catalog.ts";
import { fillTemplate } from "./fill.ts";
import type { PromptMessage, PromptRole } from "./templates.ts";

export const HISTORY_SLOT = "{history_messages}";

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

/**
 * Saved before 2026-10-02 (her own saves and the old versions she can roll back to), the program added some words
 * itself. Those words are put into the text now, the same as migrations/0055 did, so nothing goes missing and
 * nothing is hidden.
 */
const LEGACY_WORDS: Array<[string, string]> = [
  [
    "{identity_block}{system_prompt}\n\n",
    "【清然的身份】\n{identity}\n\n{system_prompt}\n\n清然在床上的样子：\n{intimate_notes}\n\n",
  ],
  ["{identity_block}", "【清然的身份】\n{identity}\n\n"],
];

function upgradeLegacy(key: PromptKey, doc: PromptDoc): PromptDoc {
  return {
    ...doc,
    variants: doc.variants.map((variant) => ({
      ...variant,
      messages: variant.messages.map((message) => {
        let content = message.content;
        for (const [from, to] of LEGACY_WORDS) content = content.split(from).join(to);
        if (key === "voice" && content.trim() === "现在是{clock}") {
          content = "现在是{clock}。\n\nRosie 上一次说话是 {last_said}，距现在 {since_last}。\n\n你心里记着、Rosie 看不到的：\n{inner}";
        }
        if (key === "report" && variant.id === "main" && content.trim() === "{summaries}") {
          content = "【每天的记录】（每天的时间线，带时间）\n{timelines}\n\n【对话摘要】\n{summaries}";
        }
        return content === message.content ? message : { ...message, content };
      }),
    })),
  };
}

/** A saved prompt: the current two-variant JSON, or an old plain-text body (taken as the system message). */
export function parsePromptBody(key: PromptKey, body: string | null | undefined): PromptDoc {
  return upgradeLegacy(key, parseSaved(key, body));
}

function parseSaved(key: PromptKey, body: string | null | undefined): PromptDoc {
  const fallback = defaultDoc(key);
  const raw = (body ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) return fallback;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<PromptDoc>;
      if (parsed && parsed.v === 2 && Array.isArray(parsed.variants)) {
        return normalizeDoc(key, parsed as PromptDoc);
      }
    } catch {
      /* legacy plain text */
    }
  }
  if (raw === defaultPrompt(key)) return fallback;
  const next = defaultDoc(key);
  for (const variant of next.variants) {
    const systemMessage = variant.messages.find((message) => message.role === "system");
    if (systemMessage) systemMessage.content = raw;
    else if (variant.messages[0]) variant.messages[0].content = raw;
  }
  return next;
}

const TOKEN = /\{([a-z][a-z0-9_]*)\}/g;

/**
 * Fill a message. A paragraph (blank lines around it) whose {…} are all empty is left out whole, heading and all:
 * that is how 「【清然的身份】\n{identity}」 disappears when there is no identity. Nothing else is added or removed.
 */
export function fillParagraphs(content: string, vars: Record<string, string>): string {
  return content
    .split(/\n{2,}/)
    .filter((block) => {
      const tokens = [...block.matchAll(TOKEN)].map((m) => m[1]!).filter((t) => Object.prototype.hasOwnProperty.call(vars, t));
      return !tokens.length || tokens.some((t) => vars[t]!.trim());
    })
    .map((block) => fillTemplate(block, vars))
    .join("\n\n");
}

export function renderPromptMessages(
  messages: PromptMessage[],
  vars: Record<string, string>,
  history: RenderedMessage[] = [],
): RenderedMessage[] {
  const out: RenderedMessage[] = [];
  for (const message of messages) {
    if (message.content.trim() === HISTORY_SLOT) {
      out.push(...history);
      continue;
    }
    const content = fillParagraphs(message.content, vars);
    // A system message with nothing left in it is not sent.
    if (message.role === "system" && !content.trim()) continue;
    out.push({ role: message.role, content });
  }
  return out;
}

export function renderVariant(
  doc: PromptDoc,
  variantId: string,
  vars: Record<string, string>,
  history: RenderedMessage[] = [],
): RenderedMessage[] {
  return renderPromptMessages(variantMessages(doc, variantId), vars, history);
}

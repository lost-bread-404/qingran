import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { brainPreviewPrompt } from "@/lib/lover/brain/api";
import { isPromptKey } from "@/lib/lover/brain/prompts/catalog";
import { parsePromptBody, serializeDoc, type PromptDoc } from "@/lib/lover/brain/prompts/doc";
import type { PromptRole } from "@/lib/lover/brain/prompts/templates";
import { VOICE_EFFORT_OPTIONS, type VoiceEffort } from "@/lib/lover/types";
import { cn } from "@/lib/utils";
import { messagesText } from "@/lib/lover/call-log-view";

type VersionHit = { hash: string; lastSeen: number };

export type PromptModelChoice = {
  id: string;
  blurb: string;
  supportsEffort: boolean;
  stats: {
    n: number;
    avgMs: number | null;
    avgTtftMs: number | null;
    emptyRate: number | null;
  } | null;
};

function effortForModel(model: PromptModelChoice, current: VoiceEffort): VoiceEffort {
  if (!model.supportsEffort) return null;
  return current === "low" || current === "medium" || current === "high" ? current : "low";
}

export type PromptEditorItem = {
  key: string;
  name: string;
  blurb: string;
  placeholders: Array<{ token: string; meaning: string }>;
  body: string;
  hash: string;
  custom: boolean;
  updatedAt: number | null;
  versions?: VersionHit[];
};

type Preview = {
  messages: Array<{ role: string; content: string }>;
  note: string;
};

const ROLES: PromptRole[] = ["system", "user", "assistant"];

function docOf(key: string, body: string): PromptDoc | null {
  if (!isPromptKey(key)) return null;
  return parsePromptBody(key, body);
}

export function PromptStepEditor({
  item,
  draft,
  busy,
  open,
  onOpenChange,
  onDraft,
  onSave,
  onRestore,
  onRollback,
  models,
  model,
  effort,
  onModel,
}: {
  item: PromptEditorItem;
  draft: string;
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDraft: (body: string) => void;
  onSave: () => void;
  onRestore: () => void;
  onRollback: (hash: string) => void;
  /** null: this step has no model (材料的写法). */
  models: PromptModelChoice[] | null;
  model: string;
  effort: VoiceEffort;
  onModel: (model: string, effort: VoiceEffort) => void;
}) {
  const doc = docOf(item.key, draft);
  const [variantId, setVariantId] = useState(doc?.variants[0]?.id ?? "main");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const variant = doc?.variants.find((row) => row.id === variantId) ?? doc?.variants[0];
  const dirty = draft !== item.body;
  const versions = (item.versions ?? []).filter((row) => row.hash !== item.hash).slice(0, 5);
  const hasModel = item.key !== "formats";
  const choices: PromptModelChoice[] = models ?? [{ id: model, blurb: "", supportsEffort: effort != null, stats: null }];
  const selected = choices.find((opt) => opt.id === model) ?? choices[0] ?? null;

  function write(next: PromptDoc) {
    onDraft(serializeDoc(next));
    setPreview(null);
  }

  function setMessages(messages: PromptDoc["variants"][number]["messages"]) {
    if (!doc || !variant) return;
    write({ ...doc, variants: doc.variants.map((row) => (row.id === variant.id ? { ...row, messages } : row)) });
  }

  async function showPreview() {
    setLoading(true);
    try {
      const result = await brainPreviewPrompt({ data: { key: item.key, variantId: variant?.id ?? variantId, body: draft } });
      setPreview({ messages: result.messages, note: result.note });
    } catch {
      setPreview({ messages: [], note: "现在读不出来。" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <details
      className="group rounded-md bg-surface-2"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) onOpenChange(next);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm text-fg">
            <span className="truncate">{item.name}</span>
            {item.custom ? <span className="shrink-0 text-xs text-live">已改</span> : null}
            {dirty ? <span className="shrink-0 text-xs text-subtle">未记</span> : null}
          </p>
          <p className="mt-0.5 truncate text-xs text-subtle">{hasModel ? `${model}${effort ? ` · ${effort}` : ""}` : item.blurb}</p>
        </div>
        <ChevronDown className="size-4 shrink-0 text-subtle transition-transform group-open:rotate-180" />
      </summary>

      <div className="flex flex-col gap-3 px-3 pb-3">
        <p className="text-xs text-subtle">{item.blurb}</p>

        {hasModel ? (
          <div className="flex flex-col gap-2">
            <select
              aria-label="模型"
              value={model}
              className="h-11 w-full rounded-md bg-bg px-3 text-sm text-fg"
              onChange={(event) => {
                const next = choices.find((opt) => opt.id === event.target.value);
                if (next) onModel(next.id, effortForModel(next, effort));
              }}
            >
              {choices.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.id}
                </option>
              ))}
            </select>
            {selected?.supportsEffort ? (
              <div className="grid grid-cols-3 gap-1">
                {VOICE_EFFORT_OPTIONS.map((next) => (
                  <button
                    key={next}
                    type="button"
                    onClick={() => onModel(model, next)}
                    className={cn("h-11 rounded-md text-sm", effort === next ? "bg-accent text-accent-fg" : "bg-bg text-muted")}
                  >
                    {next}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {doc && doc.variants.length > 1 ? (
          <div className="flex flex-wrap gap-1">
            {doc.variants.map((row) => (
              <button
                key={row.id}
                type="button"
                className={cn("h-11 rounded-md px-3 text-sm", row.id === variant?.id ? "bg-accent text-accent-fg" : "bg-bg text-muted")}
                onClick={() => {
                  setVariantId(row.id);
                  setPreview(null);
                }}
              >
                {row.label}
              </button>
            ))}
          </div>
        ) : null}

        {variant ? (
          <div className="flex flex-col gap-2">
            {variant.messages.map((message, index) => (
              <div key={`${variant.id}-${index}`} className="rounded-md bg-bg px-3 py-3">
                {hasModel ? (
                  <div className="flex items-center gap-2">
                    <select
                      value={message.role}
                      aria-label={`第 ${index + 1} 条角色`}
                      className="h-11 min-w-0 flex-1 rounded-md bg-surface-2 px-2 text-sm text-fg"
                      onChange={(event) =>
                        setMessages(variant.messages.map((m, i) => (i === index ? { ...m, role: event.target.value as PromptRole } : m)))
                      }
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="h-11 shrink-0 px-2 text-sm text-subtle disabled:opacity-40"
                      disabled={variant.messages.length <= 1}
                      onClick={() => setMessages(variant.messages.filter((_, i) => i !== index))}
                    >
                      删除
                    </button>
                  </div>
                ) : null}
                <Textarea
                  value={message.content}
                  aria-label={`第 ${index + 1} 条正文`}
                  onChange={(event) =>
                    setMessages(variant.messages.map((m, i) => (i === index ? { ...m, content: event.target.value } : m)))
                  }
                  className={cn("min-h-28 resize-y font-mono text-sm leading-relaxed", hasModel && "mt-2")}
                />
              </div>
            ))}
            {hasModel ? (
              <button
                type="button"
                className="h-11 self-start text-sm text-fg"
                onClick={() => setMessages([...variant.messages, { role: "user", content: "" }])}
              >
                加一条消息
              </button>
            ) : null}
          </div>
        ) : (
          <Textarea value={draft} onChange={(event) => onDraft(event.target.value)} className="min-h-40 font-mono text-sm" />
        )}

        {item.placeholders.length ? (
          <ul className="flex flex-col gap-1 text-xs text-subtle">
            {item.placeholders.map((row) => (
              <li key={row.token}>
                <span className="font-mono text-fg">{`{${row.token}}`}</span> {row.meaning}
              </li>
            ))}
            <li>
              {hasModel
                ? "一段（空行隔开）里的 {…} 都是空的，这一段连标题一起不发。"
                : "一行一种。写法里的 {…} 都是空的，这一条不写；整行删掉会用回默认的写法。"}
            </li>
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy || !dirty} onClick={onSave}>
            {busy ? "记下…" : "记下"}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || !(item.custom || item.updatedAt != null)} onClick={onRestore}>
            恢复默认
          </Button>
          {hasModel ? (
            <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void showPreview()}>
              {loading ? "在读…" : "看发出去的样子"}
            </Button>
          ) : null}
        </div>

        {preview ? <FullText note={preview.note} text={messagesText(preview.messages)} /> : null}

        {versions.length ? (
          <details className="rounded-md bg-bg px-3 py-2">
            <summary className="cursor-pointer list-none text-sm text-muted [&::-webkit-details-marker]:hidden">以前的版本</summary>
            <div className="mt-2 flex flex-col">
              {versions.map((row) => (
                <button
                  key={row.hash}
                  type="button"
                  className="h-11 text-left text-sm text-fg disabled:opacity-40"
                  disabled={busy}
                  onClick={() => onRollback(row.hash)}
                >
                  回退到 {new Date(row.lastSeen).toLocaleString("zh-CN", { hour12: false })}
                </button>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </details>
  );
}

/** A whole text to read and copy: what was (or would be) sent, exactly. */
export function FullText({ text, note }: { text: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md bg-bg px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-subtle">{note}</p>
        <button
          type="button"
          className="h-11 shrink-0 text-sm text-fg"
          onClick={() =>
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="mt-2 max-h-[70vh] overflow-auto whitespace-pre-wrap break-all text-xs leading-relaxed text-fg">{text || "（空）"}</pre>
    </div>
  );
}

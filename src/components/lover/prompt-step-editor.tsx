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

function formatVoiceMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${Math.round(ms)}ms`;
}

function effortForModel(model: PromptModelChoice, current: VoiceEffort): VoiceEffort {
  if (!model.supportsEffort) return null;
  return current === "low" || current === "medium" || current === "high" ? current : "low";
}

function modelStatLine(opt: PromptModelChoice | null): string {
  if (!opt?.stats || opt.stats.n <= 0) return "未使用";
  return `最近 ${opt.stats.n} 次使用的平均花费时长 ${formatVoiceMs(opt.stats.avgMs)}`;
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
  variantId: string;
  slots: Record<string, string>;
  messages: Array<{ role: string; content: string }>;
  note: string;
  cacheKey: string;
};

const ROLES: PromptRole[] = ["system", "user", "assistant"];

function tokensIn(text: string): string[] {
  return [...text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((match) => match[1] ?? "");
}

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
  models: PromptModelChoice[] | null;
  model: string;
  effort: VoiceEffort;
  onModel: (model: string, effort: VoiceEffort) => void;
}) {
  const doc = docOf(item.key, draft);
  const [variantId, setVariantId] = useState(doc?.variants[0]?.id ?? "main");
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const [showSend, setShowSend] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const variant = doc?.variants.find((row) => row.id === variantId) ?? doc?.variants[0];
  const dirty = draft !== item.body;
  const versions = (item.versions ?? []).filter((row) => row.hash !== item.hash).slice(0, 5);
  const choices: PromptModelChoice[] = models ?? [
    { id: model, blurb: "暂无说明", supportsEffort: effort != null, stats: null },
  ];
  const selected = choices.find((opt) => opt.id === model) ?? choices[0] ?? null;

  function write(next: PromptDoc) {
    onDraft(serializeDoc(next));
  }

  function updateMessage(index: number, patch: { role?: PromptRole; content?: string }) {
    if (!doc || !variant) return;
    const messages = variant.messages.map((message, i) => (i === index ? { ...message, ...patch } : message));
    write({
      ...doc,
      variants: doc.variants.map((row) => (row.id === variant.id ? { ...row, messages } : row)),
    });
  }

  function removeMessage(index: number) {
    if (!doc || !variant || variant.messages.length <= 1) return;
    const messages = variant.messages.filter((_, i) => i !== index);
    write({
      ...doc,
      variants: doc.variants.map((row) => (row.id === variant.id ? { ...row, messages } : row)),
    });
  }

  function addMessage() {
    if (!doc || !variant) return;
    write({
      ...doc,
      variants: doc.variants.map((row) =>
        row.id === variant.id ? { ...row, messages: [...row.messages, { role: "user" as const, content: "" }] } : row,
      ),
    });
  }

  async function loadPreview(): Promise<Preview | null> {
    const cacheKey = `${variant?.id ?? variantId}\n${draft}`;
    if (preview?.cacheKey === cacheKey) return preview;
    setLoading(true);
    setPreviewError(null);
    try {
      const result = await brainPreviewPrompt({
        data: { key: item.key, variantId: variant?.id ?? variantId, body: draft },
      });
      const next = { ...result, cacheKey };
      setPreview(next);
      return next;
    } catch {
      setPreviewError("这一步现在读不出来。");
      return null;
    } finally {
      setLoading(false);
    }
  }

  const toolOnly = item.key === "busy_tool";
  const known = new Map(item.placeholders.map((row) => [row.token, row.meaning]));
  const extra = variant
    ? [...new Set(variant.messages.flatMap((message) => tokensIn(message.content)))].filter((token) => !known.has(token))
    : [];

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
          <p className="mt-0.5 truncate text-xs text-subtle">
            {toolOnly ? "回复时的工具说明（不单独调用模型）" : `${model}${effort ? ` · ${effort}` : ""} · ${item.blurb}`}
          </p>
        </div>
        <ChevronDown className="size-4 shrink-0 text-subtle transition-transform group-open:rotate-180" />
      </summary>

      <div className="flex flex-col gap-3 px-3 pb-3">
        {toolOnly ? null : (
        <div className="flex flex-col gap-2">
          <label className="text-xs text-subtle" htmlFor={`prompt-model-${item.key}`}>
            回复模型
          </label>
          <select
            id={`prompt-model-${item.key}`}
            value={model}
            disabled={models == null}
            className="h-11 w-full rounded-md bg-bg px-3 text-sm text-fg disabled:opacity-60"
            onChange={(event) => {
              const next = choices.find((opt) => opt.id === event.target.value);
              if (!next) return;
              onModel(next.id, effortForModel(next, effort));
            }}
          >
            {choices.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.id}
              </option>
            ))}
          </select>
          {models == null ? <p className="text-xs text-subtle">正在拉取模型列表…</p> : null}
          {selected?.supportsEffort ? (
            <div className="grid grid-cols-3 gap-1">
              {VOICE_EFFORT_OPTIONS.map((next) => (
                <button
                  key={next}
                  type="button"
                  onClick={() => onModel(model, next)}
                  className={cn(
                    "h-11 rounded-md text-sm",
                    effort === next ? "bg-accent text-accent-fg" : "bg-bg text-muted",
                  )}
                >
                  {next}
                </button>
              ))}
            </div>
          ) : null}
          {selected?.blurb && selected.blurb !== "暂无说明" ? (
            <p className="text-xs text-subtle">{selected.blurb}</p>
          ) : null}
          {item.key === "voice" ? <p className="text-xs text-subtle">{modelStatLine(selected)}</p> : null}
          <p className="text-xs text-subtle">切换后下一句立刻生效。</p>
          {item.key === "voice" ? (
            <p className="text-xs text-subtle">每轮回复报错或空回复会自动用 grok-4.20-0309-non-reasoning 再试一次。</p>
          ) : null}
        </div>
        )}

        {doc && doc.variants.length > 1 ? (
          <div className="flex flex-wrap gap-1">
            {doc.variants.map((row) => (
              <button
                key={row.id}
                type="button"
                className={cn(
                  "h-11 rounded-md px-3 text-sm",
                  row.id === variant?.id ? "bg-accent text-accent-fg" : "bg-bg text-muted",
                )}
                onClick={() => {
                  setVariantId(row.id);
                  setPreview(null);
                  setShowSend(false);
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
                <div className="flex items-center gap-2">
                  <span className="w-4 text-xs text-subtle">{index + 1}</span>
                  <select
                    value={message.role}
                    aria-label={`第 ${index + 1} 条角色`}
                    className="h-11 min-w-0 flex-1 rounded-md bg-surface-2 px-2 text-sm text-fg"
                    onChange={(event) => updateMessage(index, { role: event.target.value as PromptRole })}
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
                    onClick={() => removeMessage(index)}
                  >
                    删除
                  </button>
                </div>
                <Textarea
                  value={message.content}
                  aria-label={`第 ${index + 1} 条正文`}
                  onChange={(event) => updateMessage(index, { content: event.target.value })}
                  className="mt-2 min-h-28 resize-y font-mono text-sm leading-relaxed"
                />
              </div>
            ))}
            <button type="button" className="h-11 self-start text-sm text-fg" onClick={addMessage}>
              加一条消息
            </button>
          </div>
        ) : (
          <Textarea value={draft} onChange={(event) => onDraft(event.target.value)} className="min-h-40 font-mono text-sm" />
        )}

        {item.placeholders.length || extra.length ? (
          <details className="rounded-md bg-bg px-3 py-2">
            <summary className="cursor-pointer list-none text-sm text-fg [&::-webkit-details-marker]:hidden">
              占位符
            </summary>
            <ul className="mt-2 flex flex-col gap-2 text-xs text-subtle">
              {item.placeholders.map((row) => (
                <li key={row.token}>
                  <span className="text-fg">{`{${row.token}}`}</span>
                  {" · "}
                  {row.meaning}{" "}
                  <button
                    type="button"
                    className="text-fg underline underline-offset-2"
                    onClick={() => {
                      if (openSlot === row.token) {
                        setOpenSlot(null);
                        return;
                      }
                      setOpenSlot(row.token);
                      void loadPreview();
                    }}
                  >
                    查看当前内容
                  </button>
                  {openSlot === row.token ? (
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 px-2 py-2 text-xs leading-relaxed text-fg">
                      {loading && !preview ? "在读…" : previewError && !preview ? previewError : (preview?.slots[row.token] ?? "（空）")}
                    </pre>
                  ) : null}
                </li>
              ))}
              {extra.map((token) => (
                <li key={token}>
                  <span className="text-fg">{`{${token}}`}</span>
                  {" · 模板里写了，但这一步没有对应的数据。"}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy || !dirty} onClick={onSave}>
            {busy ? "记下…" : "记下"}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || !(item.custom || item.updatedAt != null)} onClick={onRestore}>
            恢复默认
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => {
              setShowSend(true);
              void loadPreview();
            }}
          >
            预览实际发送内容
          </Button>
        </div>

        {showSend ? (
          <div className="rounded-md bg-bg px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-subtle">{preview?.note || previewError || (loading ? "在读…" : "")}</p>
              <button
                type="button"
                className="h-11 shrink-0 text-sm text-fg"
                onClick={() => {
                  const text = JSON.stringify(preview?.messages ?? [], null, 2);
                  void navigator.clipboard?.writeText(text).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                  });
                }}
              >
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-fg">
              {(preview?.messages ?? []).map((message) => `${message.role}\n${message.content}`).join("\n\n") || "（空）"}
            </pre>
          </div>
        ) : null}

        {versions.length ? (
          <details className="rounded-md bg-bg px-3 py-2">
            <summary className="cursor-pointer list-none text-sm text-muted [&::-webkit-details-marker]:hidden">
              以前的版本
            </summary>
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

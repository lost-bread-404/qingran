import { useState } from "react";
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

function formatEmptyRate(rate: number | null): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}

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

  const known = new Map(item.placeholders.map((row) => [row.token, row.meaning]));
  const extra = variant
    ? [...new Set(variant.messages.flatMap((message) => tokensIn(message.content)))].filter((token) => !known.has(token))
    : [];

  return (
    <details open className="rounded-md bg-surface-2 px-3 py-2">
      <summary className="cursor-pointer">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-fg">{item.name}</span>
          {item.custom ? <span className="text-[11px] text-live">已改</span> : null}
        </div>
        <p className="mt-1 text-xs text-subtle">{item.blurb}</p>
        {variant ? (
          <p className="mt-1 text-[11px] text-muted">
            {variant.messages.map((message) => message.role).join(" · ") || "没有消息"}
          </p>
        ) : null}
      </summary>
      <details className="mt-3 rounded-md bg-bg px-3 py-2">
        <summary className="cursor-pointer text-sm text-fg">
          回复模型 {model}
          {effort ? ` · ${effort}` : ""}
        </summary>
        <p className="mt-2 text-xs text-subtle">
          只给这一条用。切换后下一次跑到这一条就生效。
          {item.key === "voice" ? "每轮回复报错或空回复会自动用 grok-4.20-0309-non-reasoning 再试一次。" : ""}
        </p>
        <p className="mt-1 text-xs text-subtle">切换后下一句立刻生效。</p>
        {models == null ? <p className="mt-2 text-xs text-subtle">正在拉取模型列表…</p> : null}
        <div className="mt-2 flex flex-col gap-2">
          {(models ?? [{ id: model, blurb: "暂无说明", supportsEffort: effort != null, stats: null }]).map((opt) => {
            const selected = model === opt.id;
            return (
              <div
                key={opt.id}
                className={cn("rounded-md px-3 py-3", selected ? "bg-accent text-accent-fg" : "bg-bg text-muted")}
              >
                <button
                  type="button"
                  onClick={() => onModel(opt.id, effortForModel(opt, effort))}
                  className="min-h-11 w-full text-left text-sm"
                >
                  <span className="block font-medium">{opt.id}</span>
                  <span className={cn("mt-1 block text-xs", selected ? "opacity-90" : "text-subtle")}>{opt.blurb}</span>
                  <span className={cn("mt-1 block text-[11px]", selected ? "opacity-80" : "text-subtle")}>
                    {opt.stats && opt.stats.n > 0
                      ? `近7天 平均 ${formatVoiceMs(opt.stats.avgMs)} · 首字 ${formatVoiceMs(opt.stats.avgTtftMs)} · 空回复 ${formatEmptyRate(opt.stats.emptyRate)} · ${opt.stats.n} 次`
                      : "未使用"}
                  </span>
                </button>
                {opt.supportsEffort ? (
                  <div className="mt-2 grid grid-cols-3 gap-1">
                    {VOICE_EFFORT_OPTIONS.map((next) => (
                      <button
                        key={next}
                        type="button"
                        onClick={() => onModel(opt.id, next)}
                        className={cn(
                          "min-h-11 rounded-md px-2 text-xs",
                          selected && effort === next ? "bg-bg text-fg" : selected ? "bg-black/10" : "bg-surface-2",
                        )}
                      >
                        {next}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </details>
      <p className="mt-2 text-[11px] text-subtle">
        一组消息，按发出去的顺序。代码只填占位符，不再在后面另接一段。{"{system_prompt}"} 仍是「人设」那一份。
      </p>
      {doc && doc.variants.length > 1 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {doc.variants.map((row) => (
            <button
              key={row.id}
              type="button"
              className={`rounded px-2 py-1 text-[11px] ${row.id === variant?.id ? "bg-accent text-accent-fg" : "bg-surface text-muted"}`}
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
        <div className="mt-2 flex flex-col gap-2">
          {variant.messages.map((message, index) => (
            <div key={`${variant.id}-${index}`} className="rounded bg-surface px-2 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-subtle">{index + 1}</span>
                <select
                  value={message.role}
                  className="h-8 rounded bg-surface-2 px-2 text-xs text-fg"
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
                  className="ml-auto text-[11px] text-subtle underline underline-offset-2 disabled:opacity-40"
                  disabled={variant.messages.length <= 1}
                  onClick={() => removeMessage(index)}
                >
                  删除
                </button>
              </div>
              <Textarea
                value={message.content}
                onChange={(event) => updateMessage(index, { content: event.target.value })}
                className="mt-2 min-h-28 resize-y font-mono text-xs leading-relaxed"
              />
            </div>
          ))}
          <button type="button" className="self-start text-[11px] text-fg underline underline-offset-2" onClick={addMessage}>
            加一条消息
          </button>
        </div>
      ) : (
        <Textarea value={draft} onChange={(event) => onDraft(event.target.value)} className="mt-2 min-h-40 font-mono text-xs" />
      )}
      <ul className="mt-3 flex flex-col gap-1 text-[11px] text-subtle">
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
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface px-2 py-1 text-[11px] leading-relaxed text-fg">
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
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="pill" disabled={busy || !dirty} onClick={onSave}>
          {busy ? "记下…" : "记下"}
        </Button>
        <Button type="button" variant="outline" disabled={busy || !(item.custom || item.updatedAt != null)} onClick={onRestore}>
          恢复默认
        </Button>
        <Button
          type="button"
          variant="outline"
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
        <div className="mt-2 rounded bg-surface px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-subtle">{preview?.note || previewError || (loading ? "在读…" : "")}</p>
            <button
              type="button"
              className="text-[11px] text-fg underline underline-offset-2"
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
          <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-fg">
            {(preview?.messages ?? [])
              .map((message) => `${message.role}\n${message.content}`)
              .join("\n\n") || "（空）"}
          </pre>
        </div>
      ) : null}
      {versions.length ? (
        <div className="mt-2 flex flex-col gap-1">
          <p className="text-[11px] text-subtle">最近改过的版本，可以退回去。</p>
          {versions.map((row) => (
            <button
              key={row.hash}
              type="button"
              className="text-left text-[11px] text-fg underline underline-offset-2"
              disabled={busy}
              onClick={() => onRollback(row.hash)}
            >
              回退到 {new Date(row.lastSeen).toLocaleString("zh-CN", { hour12: false })}
            </button>
          ))}
        </div>
      ) : null}
    </details>
  );
}

export type CallLogMessage = {
  role: string;
  content: string;
  label: string;
};

export const LOG_ROUTE_FILTERS = [
  ["voice", "voice"],
  ["reflect", "reflect"],
  ["archive", "archive"],
  ["dusk", "dusk"],
  ["portrait", "portrait"],
  ["assign", "assign"],
  ["synth", "synth"],
  ["report", "report"],
  ["ask", "ask"],
  ["judge", "judge"],
  ["backfill", "backfill"],
  ["hear", "hear"],
] as const;

export const LOG_RANGE_FILTERS = [
  ["1d", "24 小时"],
  ["7d", "7 天"],
  ["30d", "30 天"],
] as const;

export type LogRangeId = (typeof LOG_RANGE_FILTERS)[number][0];

export function logRangeMs(id: LogRangeId): number {
  if (id === "1d") return 86_400_000;
  if (id === "7d") return 7 * 86_400_000;
  return 30 * 86_400_000;
}

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

export function labelCallMessages(messages: Array<{ role: string; content: string }>): CallLogMessage[] {
  const lastUserIdx = messages.reduce((acc, row, i) => (row.role === "user" ? i : acc), -1);
  const hasAssistant = messages.some((row) => row.role === "assistant");
  let systemCount = 0;
  return messages.map((row, i) => {
    let label = row.role;
    if (row.role === "system") {
      systemCount += 1;
      label = systemCount === 1 ? "system" : "注入块";
    } else if (row.role === "user" && i === lastUserIdx) {
      label = "用户消息";
    } else if (row.role === "assistant" || (row.role === "user" && hasAssistant)) {
      label = "历史";
    } else if (row.role === "user") {
      label = "注入块";
    }
    return { role: row.role, content: row.content, label };
  });
}

export function formatCallLogPlain(opts: {
  step: string;
  model?: string | null;
  effort?: string | null;
  ms?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  tokensCached?: number | null;
  tokensReasoning?: number | null;
  costUsd?: number | null;
  finishReason?: string | null;
  error?: string | null;
  inputChars?: number | null;
  trimmed?: boolean;
  messages: CallLogMessage[];
  output: string;
}): string {
  const lines = [
    `步骤 ${opts.step}`,
    `模型 ${opts.model || "—"}`,
    `effort ${opts.effort || "—"}`,
    `耗时 ${opts.ms != null ? `${opts.ms}ms` : "—"}`,
    `tokens in ${opts.tokensIn ?? "—"} · out ${opts.tokensOut ?? "—"} · cached ${opts.tokensCached ?? "—"} · reasoning ${opts.tokensReasoning ?? "—"}`,
    `input_chars ${opts.inputChars ?? "—"}`,
    `finish_reason ${opts.finishReason || "—"}`,
    `error ${opts.error || "—"}`,
  ];
  if (opts.trimmed) lines.push("已截断");
  if (opts.costUsd != null && Number.isFinite(opts.costUsd)) lines.push(`cost ${opts.costUsd}`);
  lines.push("", "—— 输入 ——");
  if (!opts.messages.length) lines.push("（空）");
  for (const row of opts.messages) {
    lines.push("", `【${row.label} · ${row.role}】`, row.content || "（空）");
  }
  lines.push("", "—— 输出 ——", opts.output || "（空）");
  return lines.join("\n");
}

export function formatDbBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "未知";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

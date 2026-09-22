import { slowEngineHint } from "./select.ts";

export type HearingTiming = {
  silenceMs?: number | null;
  uploadMs?: number | null;
  sttMs?: number | null;
  correctMs?: number | null;
  engineRequested?: string | null;
  engineUsed?: string | null;
};

export type ParsedHearingTiming = {
  silenceMs: number | null;
  uploadMs: number | null;
  sttMs: number | null;
  correctMs: number | null;
};

export function formatMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.max(0, Math.round(value))}ms`;
}

export function formatHearingLogNote(t: HearingTiming): string {
  const lines: string[] = [];
  const hint = slowEngineHint(t.engineRequested);
  if (hint) lines.push(hint);
  lines.push(
    `静音等待 ${formatMs(t.silenceMs)} · 上传 ${formatMs(t.uploadMs)} · STT ${formatMs(t.sttMs)} · 纠错 ${formatMs(t.correctMs)}`,
  );
  if (t.engineUsed) lines.push(`engine=${t.engineUsed}`);
  return lines.join("\n");
}

export function parseHearingTimingLine(note: string | null | undefined): ParsedHearingTiming | null {
  if (!note) return null;
  const m = note.match(
    /静音等待\s+(\d+|—)(?:ms)?\s*·\s*上传\s+(\d+|—)(?:ms)?\s*·\s*STT\s+(\d+|—)(?:ms)?\s*·\s*纠错\s+(\d+|—)(?:ms)?/,
  );
  if (!m) return null;
  const num = (raw: string) => (raw === "—" ? null : Number(raw));
  return {
    silenceMs: num(m[1] ?? "—"),
    uploadMs: num(m[2] ?? "—"),
    sttMs: num(m[3] ?? "—"),
    correctMs: num(m[4] ?? "—"),
  };
}

export function formatHearingTimingSummary(t: ParsedHearingTiming): string {
  return `静音 ${formatMs(t.silenceMs)} · 上传 ${formatMs(t.uploadMs)} · STT ${formatMs(t.sttMs)} · 纠错 ${formatMs(t.correctMs)}`;
}

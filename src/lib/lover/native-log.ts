export type NativeCallLogRow = {
  ok: boolean;
  ms: number | null;
  error: string | null;
  note: string | null;
};

export function nativeCallLogRow(body: unknown): NativeCallLogRow {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const ms = typeof raw.ms === "number" && Number.isFinite(raw.ms) ? Math.max(0, Math.round(raw.ms)) : null;
  const error = typeof raw.error === "string" ? raw.error.trim().slice(0, 500) : null;
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 500) : null;
  return {
    ok: raw.ok === true,
    ms,
    error: error || null,
    note: note || null,
  };
}

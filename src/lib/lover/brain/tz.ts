export const FALLBACK_TZ = "America/New_York";

export function resolveTz(tz?: string | null): string {
  const v = (tz ?? "").trim();
  return v || FALLBACK_TZ;
}

export function formatClock(nowMs: number, timeZone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      weekday: "short",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString();
  }
}

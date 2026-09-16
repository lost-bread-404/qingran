/** Fire-and-forget Neon / memory-index warm-up. Call once when entering the call page. */
export function warmBrain(): void {
  void fetch("/api/warm", { method: "GET", keepalive: true }).catch(() => undefined);
}

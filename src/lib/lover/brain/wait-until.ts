/**
 * Run a promise after the HTTP response is sent when Vercel `waitUntil` exists.
 * The promise always starts here; waitUntil only tells the platform to keep
 * the isolate alive. Locally waitUntil is a no-op without request context.
 */
export async function runInBackground(task: () => Promise<unknown>): Promise<void> {
  const work = task().catch((err) => {
    console.error("[brain] background drain", err);
  });
  try {
    const mod = await import("@vercel/functions");
    if (typeof mod.waitUntil === "function") {
      mod.waitUntil(work);
      return;
    }
  } catch {
    /* package missing */
  }
  console.info("[brain] waitUntil unavailable, draining without awaiting the request");
}
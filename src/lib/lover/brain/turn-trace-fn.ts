import { createServerFn } from "@tanstack/react-start";

function labSecret(): string {
  if (process.env.HEARING_LAB_PASSWORD) return process.env.HEARING_LAB_PASSWORD;
  if (!process.env.DATABASE_URL) return "qingran";
  return "";
}

function assertLab(password: string) {
  const secret = labSecret();
  if (!secret || password !== secret) throw new Error("lab-locked");
}

export const markTurnInterruptedFn = createServerFn({ method: "POST" })
  .validator((input: { turnId: string }) => input)
  .handler(async ({ data }) => {
    const { markTurnInterrupted } = await import("./turn-trace.ts");
    await markTurnInterrupted(data.turnId);
    return { ok: true as const };
  });

export const listTurnFeedbackFn = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    try {
      assertLab(data.password);
      const { listTurnFeedback } = await import("./turn-trace.ts");
      return { ok: true as const, rows: await listTurnFeedback() };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
        rows: [],
      };
    }
  });

export const exportTurnFeedbackFn = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    const { listTurnFeedback } = await import("./turn-trace.ts");
    const rows = await listTurnFeedback(1000);
    return { kind: "qingran-turn-feedback" as const, exportedAt: new Date().toISOString(), rows };
  });

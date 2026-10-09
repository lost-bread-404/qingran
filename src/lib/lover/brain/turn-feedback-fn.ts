import { createServerFn } from "@tanstack/react-start";
import { assertLab } from "../lab.ts";
import { newId } from "../storage.ts";

/** Her thumbs-up, or thumbs-down with 差在哪, on one of his replies (`turn_feedback`, docs/feedback.md). */
export const flagQingranReply = createServerFn({ method: "POST" })
  .validator((input: { messageId: string; note: string; rating?: "up" | "down"; tags?: string[] }) => input)
  .handler(async ({ data }) => {
    try {
      const { insertTurnFeedback } = await import("./turn-feedback.ts");
      const rating = data.rating === "up" ? "up" : "down";
      await insertTurnFeedback({
        id: newId(),
        turnId: data.messageId,
        messageId: String(data.messageId),
        rating,
        note: String(data.note ?? "").trim().slice(0, 200),
        tags: rating === "up" ? [] : data.tags,
      });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

/** The lab's 反馈 page. */
export const listTurnFeedbackFn = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    try {
      assertLab(data.password);
      const { listTurnFeedback } = await import("./turn-feedback.ts");
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
    const { listTurnFeedback } = await import("./turn-feedback.ts");
    const rows = await listTurnFeedback(1000);
    return { kind: "qingran-turn-feedback" as const, exportedAt: new Date().toISOString(), rows };
  });

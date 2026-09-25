import { now } from "./clock.ts";
import { applyGlowDelta, clampInHours, GLOW_HALF_LIFE_MS } from "./life.ts";
import { insertGlowEvent, saveReach } from "./life-store.ts";
import { applyReflectOutput } from "./mind-parse.ts";
import { parseInnerPayload } from "./voice/inner-cut.ts";
import { appendInnerLog, getInner, getProfileData, saveInner } from "./store.ts";
import { lockedProfile } from "../types.ts";

const RAW_MAX = 8_000;

/**
 * Write the hidden tail from a successful reply onto qr_inner.
 * No separator or a bad payload leaves the previous state alone.
 */
export async function commitReplyInner(input: {
  turnSeq: number;
  /** null when the model never wrote the mark. */
  tail: string | null;
  model?: string | null;
  ms?: number | null;
}): Promise<"applied" | "missing" | "parse_error"> {
  const model = input.model ?? null;
  const ms = input.ms ?? null;
  if (input.tail == null) {
    await appendInnerLog({
      turnSeq: input.turnSeq,
      data: { kind: "inner_missing", raw: "" },
      model,
      ms,
    });
    return "missing";
  }
  const parsed = parseInnerPayload(input.tail);
  if (!parsed.ok) {
    await appendInnerLog({
      turnSeq: input.turnSeq,
      data: {
        kind: "inner_parse_error",
        reason: parsed.reason,
        raw: input.tail.slice(0, RAW_MAX),
      },
      model,
      ms,
    });
    return "parse_error";
  }

  const at = now();
  const prev = await getInner();
  const applied = applyReflectOutput(prev, parsed.value, at, input.turnSeq);
  const profile = lockedProfile(await getProfileData());
  const half = Math.round(profile.glowHalfLifeDays * 24 * 60 * 60 * 1000) || GLOW_HALF_LIFE_MS;
  if (applied.glow && applied.glow.delta) {
    const nextGlow = applyGlowDelta(applied.next.glow, applied.next.glow_at, at, applied.glow.delta, half);
    applied.next.glow = nextGlow.glow;
    applied.next.glow_at = nextGlow.glowAt;
    if (nextGlow.event) {
      await insertGlowEvent({
        at,
        delta: applied.glow.delta,
        why: applied.glow.why,
        source: "reply",
        turnSeq: input.turnSeq,
        glowAfter: nextGlow.glow,
      });
    }
  }
  if (applied.nextReach !== undefined) {
    const hours = applied.nextReach ? clampInHours(applied.nextReach.inHours) : null;
    await saveReach({
      nextAt: hours == null ? null : at + hours * 3_600_000,
      intent: applied.nextReach?.intent ?? "",
      setBy: "reply",
      setAt: at,
      retry: 0,
    });
  }
  await saveInner(applied.next, input.turnSeq, {
    model: model ?? undefined,
    ms: ms ?? undefined,
    log: {
      kind: "reply",
      output: parsed.value,
      applied: applied.next,
      discarded: applied.discarded,
    },
  });
  return "applied";
}

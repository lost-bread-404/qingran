import { LONGING_TTL_MS, PICK_MAX, PLAN_MAX_HOURS, PLAN_OPEN_MAX, SESSION_GAP_MS } from "./config.ts";
import type { InnerPlan, InnerPlanStatus, InnerState, Mind } from "./types.ts";
import { EMPTY_INNER, EMPTY_MIND } from "./types.ts";

function clipPlain(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max);
}

function asStringList(raw: unknown, max: number, each: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => clipPlain(s, each))
    .filter(Boolean)
    .slice(0, max);
}

const INSIGHT_DIRECTIVE = /不要|不再|不应该|该去/;

/** A behavioral order to myself, not an understanding of her. */
export function insightDirectiveReason(insight: string): string | null {
  const hit = insight.match(INSIGHT_DIRECTIVE);
  if (!hit) return null;
  return `insight 写成了行为指令（含「${hit[0]}」），本轮内心无效，不注入回复`;
}

export function coerceMind(raw: unknown, turnSeq = 0, updatedAt?: number): Mind {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const insight = typeof row.insight === "string" ? row.insight : "";
  const memory_ids = asStringList(row.memory_ids, PICK_MAX, 80);
  const mind: Mind = { ...EMPTY_MIND, turn_seq: turnSeq, insight, memory_ids };
  if (updatedAt) mind.updated_at = updatedAt;
  return mind;
}

export function validateMind(raw: unknown, _prev: Mind, allowedIds: Set<string>): Mind {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const insight = clipPlain(String(row.insight ?? ""), 1200);
  const memory_ids = asStringList(row.memory_ids, PICK_MAX, 80).filter((id) => allowedIds.has(id));
  if (!insight || insightDirectiveReason(insight)) {
    return { ...EMPTY_MIND, memory_ids: insightDirectiveReason(insight) ? [] : memory_ids };
  }
  return { ...EMPTY_MIND, insight, memory_ids };
}

const FIELD_MAX = 1200;
const PLAN_TEXT_MAX = 400;

/**
 * Negative intent in `now` only. Bare 别 skips 特别 / 别人 / 别的 / 区别 / 差别 / 告别 / 识别 / 分别
 * so a feeling like 「特别想抱着你」 is kept. Deviation from the loose `/别/` sketch.
 */
const NOW_REJECT =
  /不要|别再|(?<![特区差告识分])别(?![的人])|不再|没有再|不去|不会再|不能|不催|停止|避免/;

export function nowRejectedReason(nowText: string): string | null {
  const hit = nowText.match(NOW_REJECT);
  if (!hit) return null;
  return `now 写成了否定式意图（含「${hit[0]}」），本轮不注入`;
}

export type MomentText = { feel: string; want: string; now: string; longing: string };

export type MomentInject = MomentText & {
  stale: { moment: boolean; longing: boolean };
};

export function momentForVoice(inner: InnerState, nowMs: number, enabled: boolean): MomentInject {
  const momentStale = !inner.updated_at || nowMs - inner.updated_at > SESSION_GAP_MS;
  const longingStale = !inner.longing_updated_at || nowMs - inner.longing_updated_at > LONGING_TTL_MS;
  if (!enabled) {
    return { feel: "", want: "", now: "", longing: "", stale: { moment: true, longing: true } };
  }
  return {
    feel: momentStale ? "" : inner.feel.trim(),
    want: momentStale ? "" : inner.want.trim(),
    now: momentStale ? "" : inner.now.trim(),
    longing: longingStale ? "" : inner.longing.trim(),
    stale: { moment: momentStale, longing: longingStale },
  };
}

function clipField(raw: unknown, max = FIELD_MAX): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  return t.length <= max ? t : t.slice(0, max);
}

function planStatus(raw: unknown, fallback: InnerPlanStatus): InnerPlanStatus {
  return raw === "open" || raw === "done" || raw === "dropped" ? raw : fallback;
}

function clampHours(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(PLAN_MAX_HOURS, n));
}

export function makePlanId(nowMs: number, index: number, used: Set<string>): string {
  let n = index;
  let id = `p${nowMs.toString(36)}${n.toString(36)}`;
  while (used.has(id)) {
    n += 1;
    id = `p${nowMs.toString(36)}${n.toString(36)}`;
  }
  return id;
}

export function expireOpenPlans(
  plans: InnerPlan[],
  nowMs: number,
): { plans: InnerPlan[]; dropped: Array<{ id: string; reason: string }> } {
  const dropped: Array<{ id: string; reason: string }> = [];
  const next = plans.map((plan) => {
    if (plan.status === "open" && plan.expires_at <= nowMs) {
      dropped.push({ id: plan.id, reason: "expired" });
      return { ...plan, status: "dropped" as const };
    }
    return plan;
  });
  return { plans: next, dropped };
}

export function formatOldInner(inner: InnerState, nowMs: number): string {
  const lines = [
    inner.feel.trim() ? `feel：${inner.feel.trim()}` : "",
    inner.want.trim() ? `want：${inner.want.trim()}` : "",
    inner.choice.trim() ? `choice：${inner.choice.trim()}` : "",
    inner.now.trim() ? `now：${inner.now.trim()}` : "",
    inner.longing.trim() ? `longing：${inner.longing.trim()}` : "",
  ].filter(Boolean);
  const open = inner.plans.filter((plan) => plan.status === "open");
  const planLines = open.map((plan) => {
    const hours = Math.max(0, (plan.expires_at - nowMs) / 3_600_000);
    const shown = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
    return `- id=${plan.id} what=${plan.what} trigger=${plan.trigger} 剩余${shown}小时`;
  });
  if (!lines.length && !planLines.length) return "（空）";
  return [...lines, planLines.length ? `plans：\n${planLines.join("\n")}` : ""].filter(Boolean).join("\n");
}

export function applyReflectOutput(
  prev: InnerState,
  raw: unknown,
  nowMs: number,
  turnSeq: number,
): { next: InnerState; discarded: Record<string, unknown> } {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const feel = clipField(row.feel);
  const want = clipField(row.want);
  const choice = clipField(row.choice);
  let nowText = clipField(row.now);
  const longing = clipField(row.longing);
  const discarded: Record<string, unknown> = {};
  const rejected = nowRejectedReason(nowText);
  if (rejected) {
    discarded.now_rejected = { reason: rejected, text: nowText };
    nowText = "";
  }
  const plans = mergePlans(prev.plans, row.plans, nowMs, discarded);
  const longingChanged = longing !== prev.longing.trim();
  return {
    next: {
      feel,
      want,
      choice,
      now: nowText,
      longing,
      plans,
      turn_seq: turnSeq,
      updated_at: nowMs,
      longing_updated_at: longingChanged ? nowMs : prev.longing_updated_at,
    },
    discarded,
  };
}

function mergePlans(
  prev: InnerPlan[],
  raw: unknown,
  nowMs: number,
  discarded: Record<string, unknown>,
): InnerPlan[] {
  if (!Array.isArray(raw)) return prev.map((plan) => ({ ...plan }));
  const prevById = new Map(prev.map((plan) => [plan.id, plan]));
  const used = new Set<string>();
  const next: InnerPlan[] = [];
  const drops: Array<{ id: string; reason: string }> = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const row = item as Record<string, unknown>;
    const what = clipField(row.what, PLAN_TEXT_MAX);
    const trigger = clipField(row.trigger, PLAN_TEXT_MAX);
    if (!what && !trigger) return;
    const requested = typeof row.id === "string" ? row.id.trim() : "";
    const existing = requested ? prevById.get(requested) : undefined;
    const id = existing ? existing.id : requested && !used.has(requested) ? requested : makePlanId(nowMs, index, used);
    if (used.has(id)) return;
    used.add(id);
    const fallbackHours = existing ? Math.max(0, (existing.expires_at - nowMs) / 3_600_000) : PLAN_MAX_HOURS;
    const hours = clampHours(row.expires_in_hours, fallbackHours);
    let status = planStatus(row.status, existing?.status ?? "open");
    const expires_at = nowMs + hours * 3_600_000;
    if (status === "open" && expires_at <= nowMs) {
      status = "dropped";
      drops.push({ id, reason: "expired" });
    }
    next.push({ id, what: what || existing?.what || "", trigger: trigger || existing?.trigger || "", expires_at, status });
  });
  for (const plan of prev) {
    if (!used.has(plan.id)) next.push({ ...plan });
  }
  // Keep plans that already existed. New open plans fill whatever room is left,
  // earliest first; anything past the cap is dropped (open_cap).
  const prevIds = new Set(prev.map((plan) => plan.id));
  const existingOpen = next.filter((plan) => plan.status === "open" && prevIds.has(plan.id)).length;
  let room = PLAN_OPEN_MAX - existingOpen;
  for (const plan of next) {
    if (plan.status !== "open" || prevIds.has(plan.id)) continue;
    if (room > 0) {
      room -= 1;
      continue;
    }
    plan.status = "dropped";
    drops.push({ id: plan.id, reason: "open_cap" });
  }
  if (room < 0) {
    for (let i = next.length - 1; i >= 0 && room < 0; i--) {
      const plan = next[i]!;
      if (plan.status !== "open") continue;
      plan.status = "dropped";
      drops.push({ id: plan.id, reason: "open_cap" });
      room += 1;
    }
  }
  if (drops.length) discarded.plans = drops;
  return next;
}

export { EMPTY_INNER };


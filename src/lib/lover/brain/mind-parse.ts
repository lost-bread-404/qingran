import { LONGING_TTL_MS, PICK_MAX, PLAN_OPEN_MAX, SESSION_GAP_MS } from "./config.ts";
import { glowNow, glowWord, GLOW_HALF_LIFE_MS } from "./life.ts";
import type { InnerPlan, InnerPlanStatus, InnerState, LongingItem, Mind } from "./types.ts";
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

export type MomentText = { feel: string; desire: string; now: string; longing: string; glow: string };

/** Reflect writes these in order. Desire is first so it is not swallowed by the analysis. */
export const REFLECT_OUTPUT_KEYS = [
  "desire",
  "read_her",
  "feel",
  "choice",
  "now",
  "longings",
  "plans",
  "glow",
  "next_reach",
] as const;

export function formatLongingsLine(inner: InnerState): string {
  const items = inner.longings.filter((item) => item.text.trim());
  if (!items.length) return inner.longing.trim();
  return items
    .map((item) => `${item.text.trim()}${item.since ? `（从 ${item.since} 起）` : ""}`)
    .join("；");
}

export function formatPlansForPrompt(plans: InnerPlan[]): string {
  const open = plans.filter((plan) => plan.status === "open" && plan.what.trim());
  if (!open.length) return "（没有）";
  return open
    .map((plan) => {
      const why = plan.why?.trim() ? ` why=${plan.why.trim()}` : "";
      return `- id=${plan.id} what=${plan.what.trim()}${why} status=${plan.status}`;
    })
    .join("\n");
}

export function nowNotActionReason(nowText: string): string | null {
  const text = nowText.trim();
  if (!text) return null;
  if (/(^|[，。！？、；\n])我/.test(text)) return null;
  if (!text.includes("她")) return null;
  return "now 没有以我为主语的动作，看起来是在描述她";
}

export type MomentInject = MomentText & {
  stale: { moment: boolean; longing: boolean };
};

export function momentForVoice(
  inner: InnerState,
  nowMs: number,
  enabled: boolean,
  halfLifeMs = GLOW_HALF_LIFE_MS,
): MomentInject {
  const momentStale = !inner.updated_at || nowMs - inner.updated_at > SESSION_GAP_MS;
  const longingStale = !inner.longing_updated_at || nowMs - inner.longing_updated_at > LONGING_TTL_MS;
  const word = glowWord(glowNow(inner.glow, inner.glow_at, nowMs, halfLifeMs));
  if (!enabled) {
    return { feel: "", desire: "", now: "", longing: "", glow: "", stale: { moment: true, longing: true } };
  }
  return {
    feel: momentStale ? "" : inner.feel.trim(),
    desire: momentStale ? "" : inner.desire.trim(),
    now: momentStale ? "" : inner.now.trim(),
    longing: longingStale ? "" : formatLongingsLine(inner),
    glow: word ? `${word}（比平常）` : "",
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

export function makePlanId(nowMs: number, index: number, used: Set<string>): string {
  let n = index;
  let id = `p${nowMs.toString(36)}${n.toString(36)}`;
  while (used.has(id)) {
    n += 1;
    id = `p${nowMs.toString(36)}${n.toString(36)}`;
  }
  return id;
}

/** Plans no longer expire on a clock. Kept so older callers still compile. */
export function expireOpenPlans(
  plans: InnerPlan[],
  _nowMs: number,
): { plans: InnerPlan[]; dropped: Array<{ id: string; reason: string }> } {
  return { plans: plans.map((plan) => ({ ...plan })), dropped: [] };
}

export function formatOldInner(inner: InnerState, nowMs: number): string {
  const word = glowWord(glowNow(inner.glow, inner.glow_at, nowMs));
  const lines = [
    inner.desire.trim() ? `desire：${inner.desire.trim()}` : "",
    inner.readHer.trim() ? `read_her：${inner.readHer.trim()}` : "",
    inner.feel.trim() ? `feel：${inner.feel.trim()}` : "",
    inner.choice.trim() ? `choice：${inner.choice.trim()}` : "",
    inner.now.trim() ? `now：${inner.now.trim()}` : "",
    word ? `心情：${word}` : "",
    inner.longing.trim() ? `longing：${inner.longing.trim()}` : "",
  ].filter(Boolean);
  const open = inner.plans.filter((plan) => plan.status === "open");
  const planLines = open.map((plan) => {
    const why = plan.why?.trim() ? ` why=${plan.why.trim()}` : "";
    return `- id=${plan.id} what=${plan.what}${why}`;
  });
  const longingLines = inner.longings
    .filter((item) => item.text.trim())
    .map((item) => `- ${item.text.trim()}${item.since ? `（从 ${item.since} 起）` : ""}`);
  if (!lines.length && !planLines.length && !longingLines.length) return "（空）";
  return [
    ...lines,
    longingLines.length ? `longings：\n${longingLines.join("\n")}` : "",
    planLines.length ? `plans：\n${planLines.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

export function applyReflectOutput(
  prev: InnerState,
  raw: unknown,
  nowMs: number,
  turnSeq: number,
): {
  next: InnerState;
  discarded: Record<string, unknown>;
  glow: { delta: number; why: string } | null;
  nextReach: { inHours: number; intent: string } | null | undefined;
} {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const feel = clipField(row.feel);
  const desire = clipField(row.desire) || clipField(row.want);
  const readHer = clipField(row.read_her);
  const choice = clipField(row.choice);
  let nowText = clipField(row.now);
  const longingFromList = mergeLongings(prev, row.longings, row.longing, nowMs);
  const longing = longingFromList.text;
  const discarded: Record<string, unknown> = {};
  const rejected = nowRejectedReason(nowText);
  if (rejected) {
    discarded.now_rejected = { reason: rejected, text: nowText };
    nowText = "";
  } else {
    const observed = nowNotActionReason(nowText);
    if (observed) discarded.now_not_action = { reason: observed, text: nowText };
  }
  const plans = mergePlans(prev.plans, row.plans, nowMs, discarded);
  const longingChanged = longing !== prev.longing.trim();
  const glow = parseGlow(row.glow);
  const nextReach = parseNextReach(row);
  return {
    next: {
      desire,
      readHer,
      feel,
      want: "",
      choice,
      now: nowText,
      longing,
      longings: longingFromList.items,
      plans,
      glow: prev.glow,
      glow_at: prev.glow_at,
      turn_seq: turnSeq,
      updated_at: nowMs,
      longing_updated_at: longingChanged ? nowMs : prev.longing_updated_at,
    },
    discarded,
    glow,
    nextReach,
  };
}

function dayStamp(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function mergeLongings(
  prev: InnerState,
  rawList: unknown,
  rawString: unknown,
  nowMs: number,
): { items: LongingItem[]; text: string } {
  const today = dayStamp(nowMs);
  const prevById = new Map(prev.longings.map((item) => [item.id, item]));
  let items: LongingItem[] = prev.longings.map((item) => ({ ...item }));
  if (Array.isArray(rawList)) {
    const used = new Set<string>();
    items = [];
    rawList.slice(0, 5).forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const row = item as Record<string, unknown>;
      const text = clipField(row.text, PLAN_TEXT_MAX);
      if (!text) return;
      const requested = typeof row.id === "string" ? row.id.trim() : "";
      const existing = requested ? prevById.get(requested) : undefined;
      const id = existing?.id || requested || makePlanId(nowMs, index, used);
      if (used.has(id)) return;
      used.add(id);
      items.push({ id, text, since: existing?.since || today });
    });
  } else if (typeof rawString === "string") {
    const text = clipField(rawString);
    if (!text) items = [];
    else if (prev.longings.length === 1 && prev.longings[0]?.text === text) items = prev.longings.map((item) => ({ ...item }));
    else if (prev.longing.trim() === text && prev.longings.length) items = prev.longings.map((item) => ({ ...item }));
    else items = [{ id: prev.longings[0]?.id || "l1", text, since: prev.longings[0]?.since || today }];
  }
  return { items, text: items.map((item) => item.text).join("；") };
}

function parseGlow(raw: unknown): { delta: number; why: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const delta = Number(row.delta);
  if (!Number.isFinite(delta)) return null;
  return { delta: Math.max(-30, Math.min(30, delta)), why: clipField(row.why, 200) };
}

function parseNextReach(row: Record<string, unknown>): { inHours: number; intent: string } | null | undefined {
  if (!("next_reach" in row)) return undefined;
  const raw = row.next_reach;
  if (raw == null) return null;
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const hours = Number(item.in_hours);
  if (!Number.isFinite(hours)) return null;
  return { inHours: hours, intent: clipField(item.intent, PLAN_TEXT_MAX) };
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
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const row = item as Record<string, unknown>;
    const what = clipField(row.what, PLAN_TEXT_MAX);
    const why = clipField(row.why, PLAN_TEXT_MAX);
    if (!what) return;
    const requested = typeof row.id === "string" ? row.id.trim() : "";
    const existing = requested ? prevById.get(requested) : undefined;
    const id = existing ? existing.id : requested && !used.has(requested) ? requested : makePlanId(nowMs, index, used);
    if (used.has(id)) return;
    used.add(id);
    const rejected = nowRejectedReason(what);
    if (rejected) {
      const list = Array.isArray(discarded.plan_not_positive)
        ? (discarded.plan_not_positive as Array<{ id: string; reason: string; text: string }>)
        : [];
      list.push({ id, reason: rejected, text: what });
      discarded.plan_not_positive = list;
    }
    const status = planStatus(row.status, existing?.status ?? "open");
    next.push({
      id,
      what,
      why: why || existing?.why || "",
      status,
      trigger: existing?.trigger,
      expires_at: existing?.expires_at,
    });
  });
  for (const plan of prev) {
    if (!used.has(plan.id)) next.push({ ...plan, why: plan.why || "" });
  }
  const drops: Array<{ id: string; reason: string }> = [];
  while (next.filter((plan) => plan.status === "open").length > PLAN_OPEN_MAX) {
    const earliest = next.find((plan) => plan.status === "open");
    if (!earliest) break;
    earliest.status = "dropped";
    drops.push({ id: earliest.id, reason: "open_cap" });
  }
  if (drops.length) discarded.plans = drops;
  return next;
}

export { EMPTY_INNER };


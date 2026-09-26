import { clampVoiceEffort, resolveRoute, voiceTimeoutMs, type Effort, type Route } from "../config.ts";
import { promptKeys, type PromptKey } from "./catalog.ts";

export type PromptModelPick = {
  model: string;
  effort: Effort;
};

const ROUTE_KEYS = new Set<string>(["voice", "reflect", "report", "editor"]);

function asRoute(key: string): Route | null {
  return ROUTE_KEYS.has(key) ? (key as Route) : null;
}

/** Code defaults. A saved profile pick replaces these on the next run. */
export function defaultPromptModel(key: string): PromptModelPick {
  const route = asRoute(key) ?? "voice";
  const resolved = resolveRoute(route);
  return { model: resolved.model, effort: resolved.effort };
}

export function lockPromptModels(raw: unknown): Partial<Record<PromptKey, PromptModelPick>> {
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Record<PromptKey, PromptModelPick>> = {};
  const bag = raw as Record<string, unknown>;
  for (const key of promptKeys()) {
    const row = bag[key];
    if (!row || typeof row !== "object") continue;
    const model = String((row as { model?: unknown }).model ?? "").trim().slice(0, 80);
    if (!model) continue;
    const effort = clampVoiceEffort(model, (row as { effort?: Effort }).effort);
    out[key] = { model, effort };
  }
  return out;
}

export function applyPromptModel<T extends { model: string; effort: Effort; timeoutMs: number }>(
  base: T,
  pick: PromptModelPick | null,
): T {
  if (!pick) return base;
  const effort = clampVoiceEffort(pick.model, pick.effort);
  return { ...base, model: pick.model, effort, timeoutMs: voiceTimeoutMs(effort) };
}

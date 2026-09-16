export type ModelClass =
  | "REALTIME"
  | "FAST_THINKER"
  | "WORKHORSE"
  | "ANALYST"
  | "DEEP_THINKER"
  | "AGENT";

export type Effort = "none" | "low" | "medium" | "high" | "xhigh" | null;

export const MODEL_CLASSES: Record<ModelClass, { model: string; effort: Effort }> = {
  REALTIME: { model: "grok-4.20-0309-non-reasoning", effort: null },
  FAST_THINKER: { model: "grok-4.6", effort: "low" },
  WORKHORSE: { model: "grok-4.3", effort: "low" },
  ANALYST: { model: "grok-4.3", effort: "medium" },
  DEEP_THINKER: { model: "grok-4.6", effort: "high" },
  AGENT: { model: "grok-4.6", effort: "medium" },
};

export const MODEL_CAPS: Record<
  string,
  {
    efforts: Effort[];
    functionCalling: boolean;
    structuredOutput: boolean;
    contextTokens: number;
  }
> = {
  "grok-4.6": {
    efforts: ["low", "medium", "high", "xhigh"],
    functionCalling: true,
    structuredOutput: true,
    contextTokens: 500_000,
  },
  "grok-4.5": {
    efforts: ["low", "medium", "high"],
    functionCalling: true,
    structuredOutput: true,
    contextTokens: 500_000,
  },
  "grok-4.3": {
    efforts: ["none", "low", "medium", "high"],
    functionCalling: true,
    structuredOutput: true,
    contextTokens: 1_000_000,
  },
  "grok-4.20-0309-non-reasoning": {
    efforts: [null],
    functionCalling: true,
    structuredOutput: true,
    contextTokens: 1_000_000,
  },
  "grok-4.20-0309-reasoning": {
    efforts: [null],
    functionCalling: true,
    structuredOutput: true,
    contextTokens: 1_000_000,
  },
};

export type Route =
  | "voice"
  | "reflect"
  | "archive"
  | "dusk"
  | "portrait"
  | "assign"
  | "backfill"
  | "synth"
  | "report"
  | "ask"
  | "judge";

export const ROUTES: Record<
  Route,
  { cls: ModelClass; effort?: Effort; timeoutMs: number; maxOutput: number }
> = {
  voice: { cls: "REALTIME", timeoutMs: 28_000, maxOutput: 550 },
  reflect: { cls: "FAST_THINKER", timeoutMs: 8_000, maxOutput: 4_000 },
  archive: { cls: "WORKHORSE", timeoutMs: 30_000, maxOutput: 6_000 },
  dusk: { cls: "ANALYST", timeoutMs: 60_000, maxOutput: 8_000 },
  portrait: { cls: "ANALYST", timeoutMs: 60_000, maxOutput: 6_000 },
  assign: { cls: "WORKHORSE", timeoutMs: 60_000, maxOutput: 6_000 },
  backfill: { cls: "WORKHORSE", timeoutMs: 60_000, maxOutput: 6_000 },
  synth: { cls: "DEEP_THINKER", timeoutMs: 180_000, maxOutput: 20_000 },
  report: { cls: "DEEP_THINKER", effort: "medium", timeoutMs: 120_000, maxOutput: 12_000 },
  ask: { cls: "AGENT", timeoutMs: 90_000, maxOutput: 8_000 },
  judge: { cls: "DEEP_THINKER", timeoutMs: 120_000, maxOutput: 8_000 },
};

export const VOICE_IO = {
  sttUrl: "https://api.x.ai/v1/stt",
  ttsUrl: "https://api.x.ai/v1/tts",
  ttsWsUrl: "wss://api.x.ai/v1/tts",
  voice: "eve",
  language: "zh",
  codec: "pcm",
  sampleRate: 24000,
};

export const DAY_BOUNDARY_HOUR = 4;
export const HISTORY_WINDOW = 40;
export const REFLECT_WINDOW = 12;
export const ARCHIVE_BATCH_MAX = 40;
export const ARCHIVE_MIN_OVERFLOW = 8;
export const SESSION_GAP_MS = 30 * 60_000;
export const INDEX_MAX_ITEMS = 150;
export const PICK_MAX = 6;
export const HOT_FALLBACK_K = 2;
export const MIND_MAX_CHARS = 500;
export const PORTRAIT_MAX_CHARS = 600;
export const SELF_MAX_CHARS = 300;
export const BOND_MAX_CHARS = 200;

export const LAG_MAX = 3;
export const FINDING_MIN_N11 = 4;
export const FINDING_MIN_EXPOSED = 5;
export const FINDING_MIN_LIFT = 1.5;
export const FINDING_MIN_UNEXPOSED = 5; // 对照组（没有前因的天）至少这么多天
export const FINDING_MAX_P = 0.01; // 单侧 Fisher exact test
export const RECOVERY_MAX_P = 0.05; // 恢复路径样本少，阈值放宽；报告中标注为“线索”
export const STUCK_MIN_WEEKS = 3;
export const STALL_DAYS = 14;

export const JOB_MAX_ATTEMPTS = 3;
export const DRAIN_BUDGET_MS = 15_000;
export const MANUAL_DRAIN_MS = 120_000;

export const QR_VOICE_READS_DIARY = process.env.QR_VOICE_READS_DIARY !== "false";
export const QR_CARE_CHECKIN = process.env.QR_CARE_CHECKIN === "true";

export type ResolvedRoute = {
  route: Route;
  cls: ModelClass;
  model: string;
  effort: Effort;
  timeoutMs: number;
  maxOutput: number;
};

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function parseEffort(raw: string): Effort {
  if (raw === "null" || raw === "") return null;
  if (raw === "none" || raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh") {
    return raw;
  }
  return null;
}

export function resolveRoute(route: Route): ResolvedRoute {
  const spec = ROUTES[route];
  const classCfg = MODEL_CLASSES[spec.cls];
  let model = classCfg.model;
  let effort: Effort = spec.effort !== undefined ? spec.effort : classCfg.effort;

  const classModel = env(`QR_CLASS_${spec.cls}_MODEL`);
  if (classModel) model = classModel;
  const classEffort = env(`QR_CLASS_${spec.cls}_EFFORT`);
  if (classEffort !== undefined) effort = parseEffort(classEffort);

  const routeModel = env(`QR_MODEL_${route.toUpperCase()}`);
  if (routeModel) model = routeModel;
  const routeEffort = env(`QR_EFFORT_${route.toUpperCase()}`);
  if (routeEffort !== undefined) effort = parseEffort(routeEffort);

  return {
    route,
    cls: spec.cls,
    model,
    effort,
    timeoutMs: spec.timeoutMs,
    maxOutput: spec.maxOutput,
  };
}

export function validateModelClasses(): string[] {
  const errors: string[] = [];
  for (const [cls, cfg] of Object.entries(MODEL_CLASSES) as [ModelClass, { model: string; effort: Effort }][]) {
    const caps = MODEL_CAPS[cfg.model];
    if (!caps) {
      errors.push(`${cls}: model ${cfg.model} is not in MODEL_CAPS`);
      continue;
    }
    if (!caps.efforts.includes(cfg.effort)) {
      errors.push(`${cls}: effort ${String(cfg.effort)} is not valid for ${cfg.model}`);
    }
    if (cls === "REALTIME" && !(caps.efforts.includes(null) || caps.efforts.includes("none"))) {
      errors.push(`${cls}: model must support disabling reasoning (null or none)`);
    }
    if (cls === "AGENT" && !caps.functionCalling) {
      errors.push(`${cls}: model must support function calling`);
    }
    if (cls !== "REALTIME" && !caps.structuredOutput) {
      errors.push(`${cls}: model must support structured output`);
    }
    if (cls === "DEEP_THINKER" && caps.contextTokens < 200_000) {
      errors.push(`${cls}: contextTokens must be ≥ 200k`);
    }
  }
  // 按实际生效的配置（含环境变量覆盖）逐个 route 校验
  for (const route of Object.keys(ROUTES) as Route[]) {
    const r = resolveRoute(route);
    const caps = MODEL_CAPS[r.model];
    if (!caps) {
      errors.push(`${route}: model ${r.model} is not in MODEL_CAPS`);
      continue;
    }
    if (!caps.efforts.includes(r.effort)) {
      errors.push(`${route}: effort ${String(r.effort)} is not valid for ${r.model}`);
    }
    if (r.cls === "REALTIME" && r.effort !== null && r.effort !== "none") {
      errors.push(`${route}: REALTIME must not use reasoning`);
    }
    if (r.cls === "AGENT" && !caps.functionCalling) {
      errors.push(`${route}: model must support function calling`);
    }
  }
  return [...new Set(errors)];
}

let validated: string[] | null = null;

/** 首次调用时校验模型配置；配置错误时抛出，调用方据此拒绝服务。 */
export function assertModelConfig(): void {
  validated ??= validateModelClasses();
  if (validated.length) {
    throw new Error(`[brain] invalid model config: ${validated.join("; ")}`);
  }
}

const FALLBACK_MODEL = MODEL_CLASSES.REALTIME.model;

let availability: { checked: boolean; unavailable: Set<string> } = {
  checked: false,
  unavailable: new Set(),
};

export function applyAvailabilityFallback(resolved: ResolvedRoute): ResolvedRoute {
  if (!availability.unavailable.has(resolved.model)) return resolved;
  return { ...resolved, model: FALLBACK_MODEL, effort: null };
}

export async function checkModelAvailability(apiKey: string | undefined): Promise<void> {
  if (availability.checked) return;
  availability.checked = true;
  if (!apiKey) return;
  try {
    const res = await fetch("https://api.x.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { data?: { id?: string }[] };
    const ids = new Set((body.data ?? []).map((m) => m.id).filter(Boolean) as string[]);
    if (ids.size === 0) return;
    const unavailable = new Set<string>();
    for (const cfg of Object.values(MODEL_CLASSES)) {
      if (!ids.has(cfg.model)) unavailable.add(cfg.model);
    }
    availability.unavailable = unavailable;
    if (unavailable.size) {
      console.warn("[brain] unavailable models, falling back to REALTIME:", [...unavailable]);
    }
  } catch {
    /* ignore — talk still works */
  }
}

export function resetAvailabilityForTests() {
  availability = { checked: false, unavailable: new Set() };
}

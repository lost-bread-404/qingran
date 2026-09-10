export const CONTEXT_WINDOW = 20;
export const MAX_MAIN_MEMORIES = 5;
export const MAX_CANDIDATES = 8;
export const MAX_PORTRAIT_CHARS = 600;
export const PATTERN_DORMANT_MS = 30 * 86_400_000;
export const DROPPED_PACK_LIMIT = 30;

export type PatternStatus = "active" | "dormant";
export type MemoryLayer = "l1" | "l2" | "l3";

export type OpenEvent = {
  startedAt: number;
  draft: string;
  points: string;
};

export type L1Event = {
  id: string;
  startedAt: number;
  endedAt: number;
  text: string;
  createdAt: number;
};

export type L2Event = {
  id: string;
  periodStart: number;
  periodEnd: number;
  text: string;
  createdAt: number;
};

export type L3Pattern = {
  id: string;
  status: PatternStatus;
  text: string;
  lastEvidenceAt: number;
  createdAt: number;
  updatedAt: number;
};

export type MemoryItem = {
  id: string;
  layer: MemoryLayer;
  text: string;
  startedAt: number;
  endedAt?: number;
  status?: PatternStatus;
};

export type MemoryBoard = {
  portrait: string;
  openEvent: OpenEvent | null;
  items: MemoryItem[];
};

export type Retrievable = {
  id: string;
  layer: MemoryLayer;
  text: string;
  startedAt: number;
  endedAt: number;
  status: PatternStatus;
};

export type PackedMemory = {
  time: string;
  text: string;
};

export type MainPackInput = {
  charter: string;
  clock: string;
  portrait: string;
  memories: PackedMemory[];
  openHappening: boolean;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userText: string;
};

export type DecisionA = {
  decision: "merge" | "close_and_open" | "ignore";
  closedEvent: string;
  closedStart: string;
  closedEnd: string;
  openDraft: string;
  openStart: string;
  note: string;
};

export type L2Draft = {
  time: string;
  text: string;
};

export type PatternDraft = {
  status: PatternStatus;
  time: string;
  text: string;
};

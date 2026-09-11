export const CONTEXT_WINDOW = 20;
export const MAX_MAIN_MEMORIES = 8;
export const MAX_PORTRAIT_CHARS = 900;
export const DROPPED_PACK_LIMIT = 30;

export const USER_SPEAKER = "Rosie";
export const ASSISTANT_SPEAKER = "清然";

export type PatternStatus = "active" | "dormant";
export type MemoryLayer = "l1" | "l2" | "l3";

export type OpenEvent = {
  id: string;
  startedAt: number;
  text: string;
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
  openEvents: OpenEvent[];
  items: MemoryItem[];
};

export type Retrievable = {
  id: string;
  layer: MemoryLayer | "open";
  text: string;
  startedAt: number;
  endedAt: number;
  status: PatternStatus;
};

export type PackedMemory = {
  time: string;
  text: string;
  dormant?: boolean;
  open?: boolean;
};

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

export type PackedChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
};

export type MainPackInput = {
  charter: string;
  clock: string;
  portrait: string;
  memories: PackedMemory[];
  history: ChatTurn[];
  userText: string;
};

export type MemoryFact = {
  text: string;
  time: string;
};

export type ArchiveA = {
  open: Array<{ id: string; text: string; started: string }>;
  facts: MemoryFact[];
};

export type L2Draft = {
  id: string;
  time: string;
  text: string;
};

export type PatternDraft = {
  id: string;
  status: PatternStatus;
  time: string;
  text: string;
};

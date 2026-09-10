import { createServerFn } from "@tanstack/react-start";
import { tickMemory as runTick } from "./channel";
import {
  deleteMemoryItem,
  insertL1,
  loadBoard,
  updateMemoryItem,
} from "./store";
import type { MemoryBoard, MemoryItem } from "./types";

export const loadMemoryBoard = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await loadBoard();
  } catch {
    return { portrait: "", openEvent: null, items: [] } satisfies MemoryBoard;
  }
});

export const tickMemoryBoard = createServerFn({ method: "POST" })
  .validator((input: { timeZone?: string }) => input)
  .handler(async ({ data }) => {
    await runTick(data.timeZone || "UTC");
    return { ok: true as const };
  });

export const addClosedMemory = createServerFn({ method: "POST" })
  .validator((input: { text: string }) => input)
  .handler(async ({ data }) => {
    const text = data.text.replace(/\s+/g, " ").trim();
    if (text.length < 2) return { ok: false as const };
    const now = Date.now();
    await insertL1({ startedAt: now, endedAt: now, text: text.slice(0, 200) });
    return { ok: true as const };
  });

export const editMemoryItem = createServerFn({ method: "POST" })
  .validator((input: { id: string; layer: MemoryItem["layer"]; text: string }) => input)
  .handler(async ({ data }) => {
    await updateMemoryItem(data.id, data.layer, data.text);
    return { ok: true as const };
  });

export const removeMemoryItem = createServerFn({ method: "POST" })
  .validator((input: { id: string; layer: MemoryItem["layer"] }) => input)
  .handler(async ({ data }) => {
    await deleteMemoryItem(data.id, data.layer);
    return { ok: true as const };
  });

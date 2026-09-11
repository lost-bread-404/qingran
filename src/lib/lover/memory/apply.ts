import type { ChatMessage } from "../types.ts";
import { formatDropped, parseMaybeTime } from "./prompts.ts";
import type { DecisionA, OpenEvent } from "./types.ts";

export type ClosedEventPlan = {
  startedAt: number;
  endedAt: number;
  text: string;
};

export type DecisionPlan = {
  scannedIds: string[];
  open: OpenEvent | null | "keep";
  closed: ClosedEventPlan | null;
  logKind: "ignore" | "merge" | "close_and_open";
  note: string;
};

export function planDecisionA(opts: {
  decision: DecisionA;
  dropped: ChatMessage[];
  open: OpenEvent | null;
  clock: (ms: number) => string;
  now?: number;
}): DecisionPlan {
  const ids = opts.dropped.map((m) => m.id);
  const note = opts.decision.note;
  const now = opts.now ?? Date.now();

  if (opts.decision.decision === "ignore") {
    return { scannedIds: ids, open: "keep", closed: null, logKind: "ignore", note };
  }

  if (opts.decision.decision === "merge") {
    const startedAt = parseMaybeTime(
      opts.decision.openStart,
      opts.open?.startedAt || opts.dropped[0]?.createdAt || now,
    );
    return {
      scannedIds: ids,
      open: {
        startedAt,
        draft: (opts.decision.openDraft || opts.open?.draft || "").slice(0, 800),
        points: appendPoints(opts.open?.points ?? "", opts.dropped, opts.clock),
      },
      closed: null,
      logKind: "merge",
      note,
    };
  }

  const closedText = opts.decision.closedEvent.trim() || opts.open?.draft.trim() || "";
  const closed =
    closedText && (opts.open || closedText)
      ? {
          startedAt: parseMaybeTime(
            opts.decision.closedStart,
            opts.open?.startedAt || opts.dropped[0]?.createdAt || now,
          ),
          endedAt: Math.max(
            parseMaybeTime(opts.decision.closedEnd, opts.dropped.at(-1)?.createdAt || now),
            parseMaybeTime(
              opts.decision.closedStart,
              opts.open?.startedAt || opts.dropped[0]?.createdAt || now,
            ),
          ),
          text: closedText,
        }
      : null;

  const openDraft = opts.decision.openDraft.trim();
  return {
    scannedIds: ids,
    open: openDraft
      ? {
          startedAt: parseMaybeTime(opts.decision.openStart, opts.dropped[0]?.createdAt || now),
          draft: openDraft.slice(0, 800),
          points: appendPoints("", opts.dropped, opts.clock),
        }
      : null,
    closed,
    logKind: "close_and_open",
    note,
  };
}

export function appendPoints(
  prev: string,
  dropped: ChatMessage[],
  clock: (ms: number) => string,
): string {
  const extra = formatDropped(dropped, clock);
  return `${prev}\n${extra}`.trim().slice(-2000);
}

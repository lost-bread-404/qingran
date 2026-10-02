import type { MessageMeta } from "../message-meta.ts";
/**
 * The 清然 state file: what 设置 → 数据 exports, and what it imports. Importing = initializing.
 * Full description for people (and for Claude writing an init file): docs/state-format.md.
 * Client-safe: no database imports here.
 */
export const STATE_KIND = "qingran-state";
export const STATE_VERSION = 5;

export type StateDay = { day: string; timeline: string };
/** One moment of his memory (or something he came to understand about Rosie). */
export type StateMemory = {
  kind?: "moment" | "insight";
  source?: "story" | "night" | "rosie" | "inner";
  day?: string;
  at?: string | null;
  body: string;
  keys?: string;
  thread?: string;
  importance?: number;
  changed?: string;
};
export type StateMessage = {
  id?: string;
  role: "user" | "assistant";
  /** The words only. Files from before 2026-10-02 may have ⟦…⟧ marks in front; they are read into `meta`. */
  text: string;
  at: string | number;
  kind?: string;
  forgotten?: boolean;
  /** What is known about it besides the words (see src/lib/lover/message-meta.ts). */
  meta?: MessageMeta;
};

export type StateFile = {
  kind: typeof STATE_KIND;
  version: number;
  exportedAt?: number;
  /** IANA zone every "YYYY-MM-DD HH:MM" in this file is written in. */
  timeZone?: string;
  /** Any saved setting (persona, identity, storyline, intimate notes, …). Keys left out keep their current value. */
  profile?: Record<string, unknown>;
  /** 清然和 Rosie 现在: the short text the night pass rewrites. */
  memory?: string;
  /** His moments, except the ones cut from the storyline (those come from profile.storyline). */
  memories?: StateMemory[];
  /** Each past day's timeline (04:00–04:00). */
  days?: StateDay[];
  /** Custom prompt bodies by key (voice, editor, report). Keys left out keep their current text. */
  prompts?: Record<string, string>;
  messages?: StateMessage[];
};

/** Messages go in chunks of this many. */
export const STATE_MESSAGE_CHUNK = 200;

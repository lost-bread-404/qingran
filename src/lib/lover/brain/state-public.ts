/**
 * The 清然 state file: what 设置 → 数据 exports, and what it imports. Importing = initializing.
 * Full description for people (and for Claude writing an init file): docs/state-format.md.
 * Client-safe: no database imports here.
 */
export const STATE_KIND = "qingran-state";
export const STATE_VERSION = 4;

export type StatePlan = { text: string; at?: string | null; setBy?: string };
export type StateDay = { day: string; timeline: string };
export type StateNote = { at: string | number; text: string };
export type StateMessage = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  at: string | number;
  kind?: string;
  forgotten?: boolean;
};

export type StateFile = {
  kind: typeof STATE_KIND;
  version: number;
  exportedAt?: number;
  /** IANA zone every "YYYY-MM-DD HH:MM" in this file is written in. */
  timeZone?: string;
  /** Any saved setting (persona, identity, story, modes, intimate notes, …). Keys left out keep their current value. */
  profile?: Record<string, unknown>;
  /** 我记得的: the whole memory document. */
  memory?: string;
  /** 他心里此刻. */
  heart?: string;
  /** Current mode id. */
  mode?: string;
  plans?: StatePlan[];
  /** One text per day (04:00–04:00): today's running text, and each past day's timeline. */
  days?: StateDay[];
  /** Older files (version ≤ 3): a list of notes; imported as lines in that day's text. */
  dayNotes?: StateNote[];
  /** Custom prompt bodies by key (voice, reflect, editor, report, persona_ack). Keys left out keep their current text. */
  prompts?: Record<string, string>;
  messages?: StateMessage[];
};

/** Messages go in chunks of this many. */
export const STATE_MESSAGE_CHUNK = 200;

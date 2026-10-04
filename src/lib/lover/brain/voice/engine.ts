import { getSql } from "../../../db.ts";

/**
 * Who plays 清然 now (docs/claude-grok-routing.md): Claude by default; Grok from when Claude hands the scene over
 * (〔接〕 / 〔转〕 at the very start of its reply) until Grok hands it back (〔回〕) or she has been away a while.
 * The program only reads the mark; no model call is added before a reply.
 */
export type Engine = "claude" | "grok";

/** 〔接〕: shown, Grok from the next turn. 〔转〕: dropped, Grok answers this same line. 〔回〕: back to Claude next turn. */
export type Mark = "接" | "转" | "回";


export async function getEngineMode(): Promise<Engine> {
  const db = await getSql();
  const rows = await db.query<{ mode: string | null }>(`select data->>'engineMode' as mode from brain_meta where id = 1`);
  return rows[0]?.mode === "grok" ? "grok" : "claude";
}

/** Only this key is written (other keys of brain_meta are left as they are). */
export async function setEngineMode(mode: Engine): Promise<void> {
  const db = await getSql();
  await db.query(`update brain_meta set data = coalesce(data, '{}'::jsonb) || jsonb_build_object('engineMode', $1::text) where id = 1`, [
    mode,
  ]);
}

/**
 * Who answers this turn. Away longer than `returnMin` minutes (or nothing of hers to go by) → back to Claude, saved.
 */
export async function startEngine(lastUserAt: number | null, nowMs: number, returnMin: number): Promise<{ engine: Engine; before: Engine; autoReturn: boolean }> {
  const before = await getEngineMode();
  if (before === "grok" && (lastUserAt == null || nowMs - lastUserAt > returnMin * 60_000)) {
    await setEngineMode("claude");
    return { engine: "claude", before, autoReturn: true };
  }
  return { engine: before, before, autoReturn: false };
}

/** Where the mode goes after this reply, from its mark. A failed Claude turn answered by Grok leaves it as it was. */
export function modeAfter(engine: Engine, mark: Mark | null): Engine {
  if (engine === "claude" && (mark === "接" || mark === "转")) return "grok";
  if (engine === "grok" && mark === "回") return "claude";
  return engine;
}

const MARK = /^\s*〔(接|转|回)〕\s*/;

/**
 * Reads the visible text as it streams: only the very start can be a mark. Holds the first few characters until it
 * knows; a mark is taken out, anything else is let through at once.
 */
export class MarkCut {
  mark: Mark | null = null;
  private head = "";
  private decided = false;

  /** Text to let out now ("" while still deciding). */
  push(text: string): string {
    if (this.decided) return text;
    this.head += text;
    const lead = this.head.trimStart();
    if (!lead) return "";
    if (lead[0] !== "〔") return this.release();
    if (lead.length < 3) return "";
    const m = MARK.exec(this.head);
    if (!m) return this.release();
    // Wait for what follows the mark, so the space / line break after it is taken out too.
    if (m[0].length === this.head.length) return "";
    this.mark = m[1] as Mark;
    this.head = this.head.slice(m[0].length);
    return this.release();
  }

  /** The end of the reply: whatever is still held. */
  finish(): string {
    if (this.decided) return "";
    const m = MARK.exec(this.head);
    if (m) {
      this.mark = m[1] as Mark;
      this.head = this.head.slice(m[0].length);
    }
    return this.release();
  }

  private release(): string {
    this.decided = true;
    const out = this.head;
    this.head = "";
    return out;
  }
}

/** A whole reply (not streamed): its mark and the text without it. */
export function takeMark(text: string): { mark: Mark | null; text: string } {
  const m = MARK.exec(text);
  return m ? { mark: m[1] as Mark, text: text.slice(m[0].length) } : { mark: null, text };
}

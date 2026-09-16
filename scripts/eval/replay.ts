/**
 * Eval replay: isolated PGLite, scripted nowMs, full talk+slow-path per turn.
 * Voice does not generate TTS. Run after v2 lands; not part of unit tests.
 *
 * Usage (later): node --experimental-strip-types scripts/eval/replay.ts scenarios/recall.jsonl
 */
export type ScenarioTurn = { at: number; user: string };

export async function replay(_turns: ScenarioTurn[]): Promise<{ packMs: number[]; replies: string[] }> {
  throw new Error("replay harness is a skeleton — wire PGLite + drainJobs when running eval");
}

/**
 * LLM-as-judge for 清然侧 (route `judge`) plus diary-side code checks.
 * See plan §11. Not invoked by `npm test`.
 */
export type QingranScores = {
  followed_up: 0 | 1;
  used_memory_correctly: 0 | 1;
  memory_hallucination: 0 | 1;
  expressed_own_view: 0 | 1;
  repeated_phrase: 0 | 1;
  handed_back: 0 | 1;
  felt_seen: number;
  logic: number;
  agency: number;
  persona_fit: number;
  takes_lead: number;
  devotion: number;
  warmth: number;
};

export async function judgeQingran(_args: {
  charter: string;
  transcript: string;
}): Promise<QingranScores> {
  throw new Error("judge harness is a skeleton");
}

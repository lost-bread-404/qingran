export const INTERRUPTED_MARK = "（被 Rosie 打断）";

export type InterruptQingranPlan = {
  abort: true;
  stopPlayback: true;
  markInterrupted: true;
  hear: boolean;
};

export function planInterruptQingran(input: {
  speakingOrThinking: boolean;
  callActive: boolean;
}): InterruptQingranPlan | null {
  if (!input.speakingOrThinking) return null;
  return {
    abort: true,
    stopPlayback: true,
    markInterrupted: true,
    hear: input.callActive,
  };
}

export function withInterruptedMark(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return INTERRUPTED_MARK;
  if (trimmed.endsWith(INTERRUPTED_MARK)) return trimmed;
  return `${trimmed}${INTERRUPTED_MARK}`;
}

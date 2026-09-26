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


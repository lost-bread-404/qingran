export function micActionForConfirmPanel(input: {
  panelOpen: boolean;
  wasOpen: boolean;
  callActive: boolean;
  qingranSpeaking: boolean;
}): "deafen" | "hear" | null {
  if (!input.callActive) return null;
  if (input.panelOpen) return "deafen";
  if (input.wasOpen && !input.qingranSpeaking) return "hear";
  return null;
}

export type ConfirmHushPlan = {
  stopPlayback: true;
  skipAutoPlay: true;
  abort: false;
  markInterrupted: false;
};

export function planOpenConfirmPanel(): ConfirmHushPlan {
  return {
    stopPlayback: true,
    skipAutoPlay: true,
    abort: false,
    markInterrupted: false,
  };
}

export function shouldAutoSpeakReply(input: { muted: boolean; skipAutoPlay: boolean }): boolean {
  return !input.muted && !input.skipAutoPlay;
}

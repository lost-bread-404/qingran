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

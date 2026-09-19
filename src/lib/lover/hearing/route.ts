export type AudioRoute = "headphones" | "speaker" | "unknown";
export type HearingMode = "call" | "text" | "scripted";

export function classifyAudioRoute(label: string | null | undefined): AudioRoute {
  const text = (label ?? "").toLowerCase();
  if (!text.trim()) return "unknown";
  if (/headphone|headset|airpod|earphone|earbud|bluetooth|bt |耳机|藍牙|蓝牙/.test(text)) {
    return "headphones";
  }
  if (/speaker|loudspeaker|扬声器|喇叭/.test(text)) return "speaker";
  return "unknown";
}

export async function detectAudioRoute(): Promise<AudioRoute> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return "unknown";
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter((d) => d.kind === "audiooutput");
    const preferred =
      outs.find((d) => d.deviceId === "default") ??
      outs.find((d) => d.deviceId === "communications") ??
      outs[0];
    return classifyAudioRoute(preferred?.label);
  } catch {
    return "unknown";
  }
}

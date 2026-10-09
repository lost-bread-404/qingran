/**
 * What holding to talk feels like without looking (requirements 第 7 节): a short high tone and a buzz when the press
 * takes, a lower one when she lets go, a falling pair when she slides up to cancel. In the iPhone shell the shell
 * plays these itself, with the phone's haptics (Voice.swift); here the buzz only works where the browser can vibrate.
 */

export type Cue = "press" | "release" | "cancel";

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx || ctx.state === "closed") ctx = new Ctor();
  if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
  return ctx;
}

function tone(ac: AudioContext, at: number, hz: number, ms: number, gain: number) {
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(hz, at);
  const end = at + ms / 1000;
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.006);
  amp.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(amp);
  amp.connect(ac.destination);
  osc.start(at);
  osc.stop(end + 0.02);
}

/** Call inside her touch (the browser only lets a page make a sound from a gesture). */
export function playCue(cue: Cue) {
  try {
    navigator.vibrate?.(cue === "press" ? 18 : cue === "release" ? 10 : [12, 40, 12]);
  } catch {
    /* no vibration here */
  }
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime + 0.005;
  if (cue === "press") tone(ac, now, 1320, 70, 0.22);
  else if (cue === "release") tone(ac, now, 880, 55, 0.18);
  else {
    tone(ac, now, 660, 60, 0.16);
    tone(ac, now + 0.08, 440, 80, 0.16);
  }
}

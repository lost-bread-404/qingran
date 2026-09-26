import { zonedParts } from "../time.ts";

/** Chart bands on the spend page: 0 = talking, 1 = the mind, 2 = memory, 3 = the monthly report. */
export function routePriority(route: string): 0 | 1 | 2 | 3 {
  if (["voice", "tts", "stt", "replay"].includes(route)) return 0;
  if (route === "reflect" || route === "reach" || route === "wake") return 1;
  if (route === "editor") return 2;
  return 3;
}

export function zonedWallMs(day: string, hour: number, minute: number, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number);
  let guess = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hour, minute, 0);
  for (let i = 0; i < 8; i++) {
    const p = zonedParts(guess, timeZone);
    const target = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hour, minute);
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const delta = target - actual;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

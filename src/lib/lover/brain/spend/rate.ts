import { now } from "../clock.ts";
import { bumpRate, writeAlert } from "./ledger.ts";

export const TALK_RATE_MAX = 20;
export const JOB_RATE_MAX = 60;
export const SPEND_RATE_ERR = "spend-rate";

function minuteBucket(nowMs: number): string {
  const d = new Date(nowMs);
  return d.toISOString().slice(0, 16);
}

export async function talkRateHit(sessionKey: string): Promise<{ n: number; limited: boolean }> {
  const bucket = `talk:${sessionKey}:${minuteBucket(now())}`;
  const n = await bumpRate(bucket);
  if (n === TALK_RATE_MAX + 1) {
    await writeAlert("rate", "rate", null, `talk ${n}/min`);
  }
  return { n, limited: n > TALK_RATE_MAX };
}

export async function jobRateHit(): Promise<{ n: number; limited: boolean }> {
  const bucket = `jobs:${minuteBucket(now())}`;
  const n = await bumpRate(bucket);
  if (n === JOB_RATE_MAX + 1) {
    await writeAlert("rate", "rate", null, `jobs ${n}/min`);
  }
  return { n, limited: n > JOB_RATE_MAX };
}

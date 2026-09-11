import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProsodyFrame } from "./prosody.ts";
import { listenVocal } from "./vocal-event.ts";

function frame(partial: Partial<ProsodyFrame> & Pick<ProsodyFrame, "t" | "rms">): ProsodyFrame {
  return {
    hz: 180,
    clarity: 0.9,
    centroid: 800,
    bright: 0.25,
    ...partial,
  };
}

function hush(t: number): ProsodyFrame {
  return frame({ t, rms: 0.0015, hz: 0, clarity: 0, centroid: 0, bright: 0 });
}

function pulses(count: number, dur: number, gap: number, shape: Partial<ProsodyFrame> = {}): ProsodyFrame[] {
  const out: ProsodyFrame[] = [];
  const step = 0.04;
  for (let p = 0; p < count; p += 1) {
    const t0 = p * (dur + gap);
    const n = Math.max(2, Math.round(dur / step));
    for (let i = 0; i < n; i += 1) {
      out.push(
        frame({
          rms: 0.055,
          hz: 0,
          clarity: 0.32,
          centroid: 1500,
          bright: 0.32,
          ...shape,
          t: t0 + i * step,
        }),
      );
    }
    out.push(hush(t0 + dur + gap * 0.4));
  }
  return out;
}

test("regular short noisy pulses are laughter", () => {
  const frames = pulses(6, 0.12, 0.12);
  const heard = listenVocal(frames);
  assert.equal(heard.kind, "laugh");
  assert.match(heard.text, /哈/);
  assert.doesNotMatch(heard.text, /啊|嗯|呜/);
});

test("falling voiced bursts are crying", () => {
  const frames: ProsodyFrame[] = [];
  for (let p = 0; p < 3; p += 1) {
    const t0 = p * 0.7;
    for (let i = 0; i < 12; i += 1) {
      frames.push(
        frame({
          t: t0 + i * 0.04,
          rms: 0.07 - i * 0.004,
          hz: 190,
          clarity: 0.88,
          centroid: 520,
          bright: 0.14,
        }),
      );
    }
    frames.push(hush(t0 + 0.55));
  }
  const heard = listenVocal(frames);
  assert.equal(heard.kind, "cry");
  assert.match(heard.text, /呜/);
  assert.doesNotMatch(heard.text, /哈/);
});

test("slow unvoiced bursts are panting, not laughter", () => {
  const frames = pulses(4, 0.24, 0.34, { hz: 0, clarity: 0.28, centroid: 1400, bright: 0.28 });
  const heard = listenVocal(frames);
  assert.equal(heard.kind, "pant");
  assert.match(heard.text, /啊/);
  assert.doesNotMatch(heard.text, /哈/);
});

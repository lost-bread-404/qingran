import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSampleRing,
  downsample,
  encodeWavPcm16,
  PRE_ROLL_SEC,
  pushSampleRing,
  snapshotSampleRing,
  clearSampleRing,
  wavFromTap,
} from "./pcm-tap.ts";

test("downsample 48k to 16k keeps about a third of the samples", () => {
  const input = new Float32Array(4800);
  for (let i = 0; i < input.length; i += 1) input[i] = i % 2 === 0 ? 0.2 : -0.2;
  const out = downsample(input, 48000, 16000);
  assert.equal(out.length, 1600);
});

test("encodeWavPcm16 writes a mono 16k PCM header", async () => {
  const samples = new Float32Array(16000);
  samples[10] = 0.5;
  const blob = encodeWavPcm16(samples, 16000);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const ascii = (start: number, n: number) => String.fromCharCode(...bytes.slice(start, start + n));
  assert.equal(blob.type, "audio/wav");
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(12, 4), "fmt ");
  assert.equal(bytes[20], 1);
  assert.equal(bytes[22], 1);
  assert.equal(bytes[24] | (bytes[25]! << 8) | (bytes[26]! << 16) | (bytes[27]! << 24), 16000);
  assert.equal(ascii(36, 4), "data");
  assert.equal(bytes.byteLength, 44 + 16000 * 2);
});

test("wavFromTap ignores clips that are too short", () => {
  const samples = new Float32Array(100);
  assert.equal(wavFromTap(samples, 16000), null);
  assert.ok(wavFromTap(new Float32Array(4000), 16000));
});

test("pre-roll ring keeps about 600ms and prepends it at start", () => {
  assert.equal(PRE_ROLL_SEC, 0.6);
  const rate = 16_000;
  const capacity = Math.round(rate * PRE_ROLL_SEC);
  const ring = createSampleRing();
  for (let i = 0; i < 20; i += 1) {
    const chunk = new Float32Array(rate / 10);
    chunk.fill(i === 19 ? 0.4 : 0.01 * i);
    pushSampleRing(ring, chunk, capacity);
  }
  const snap = snapshotSampleRing(ring);
  assert.ok(snap.length <= capacity);
  assert.ok(snap.length >= capacity - rate / 10);
  assert.ok(Math.abs((snap[snap.length - 1] ?? 0) - 0.4) < 1e-5);
  clearSampleRing(ring);
  assert.equal(snapshotSampleRing(ring).length, 0);
});

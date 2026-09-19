import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  INTERRUPTED_MARK,
  planInterruptQingran,
  withInterruptedMark,
} from "./interrupt.ts";

test("interrupt while speaking aborts, stops playback, marks, and hears in a call", () => {
  assert.deepEqual(planInterruptQingran({ speakingOrThinking: true, callActive: true }), {
    abort: true,
    stopPlayback: true,
    markInterrupted: true,
    hear: true,
  });
});

test("interrupt while generating still aborts even when not in a call", () => {
  assert.deepEqual(planInterruptQingran({ speakingOrThinking: true, callActive: false }), {
    abort: true,
    stopPlayback: true,
    markInterrupted: true,
    hear: false,
  });
});

test("clicking the avatar does nothing when Qingran is idle", () => {
  assert.equal(planInterruptQingran({ speakingOrThinking: false, callActive: true }), null);
  assert.equal(planInterruptQingran({ speakingOrThinking: false, callActive: false }), null);
});

test("interrupted replies keep their words and append the Rosie mark", () => {
  assert.equal(withInterruptedMark("我正要说完"), `我正要说完${INTERRUPTED_MARK}`);
  assert.equal(withInterruptedMark(""), INTERRUPTED_MARK);
  assert.equal(withInterruptedMark(`已经有了${INTERRUPTED_MARK}`), `已经有了${INTERRUPTED_MARK}`);
});

test("voice-room interrupt stops playback, aborts, marks, and hears in a call", () => {
  const src = readFileSync(new URL("../../components/lover/voice-room.tsx", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function interruptQingran"), src.indexOf("const recording ="));
  assert.match(fn, /planInterruptQingran/);
  assert.match(fn, /abortRef\.current\?\.abort/);
  assert.match(fn, /stopPlayback\(\)/);
  assert.match(fn, /interrupted: true/);
  assert.match(fn, /if \(plan\.hear\) call\.hear\(\)/);
  assert.match(src, /e\.stopPropagation\(\)/);
  assert.match(src, /lamp-orb size-10 rounded-full/);
  assert.match(src, /grid size-11 shrink-0 place-items-center/);
  assert.match(src, /aria-label=\{status === "speaking" \|\| status === "thinking" \? "打断清然" : "清然"\}/);
  assert.match(src, /onClick=\{\(\) => transcriptRef\.current\?\.pageUp\(\)\}/);
  assert.doesNotMatch(fn, /vibrate/);
  assert.doesNotMatch(fn, /playMp3Bytes/);
  assert.doesNotMatch(fn, /kickAudio/);
});

test("room messages persist the interrupted flag", () => {
  const src = readFileSync(new URL("./room.ts", import.meta.url), "utf8");
  assert.match(src, /if \(msg\.interrupted\) text = `⟦断⟧\$\{text\}`/);
  assert.match(src, /text\.startsWith\("⟦断⟧"\)/);
  assert.match(src, /interrupted: interrupted \|\| undefined/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { lockedProfile } from "./types.ts";
import {
  isNativeShell,
  nativeCallPlan,
  nativeEndCall,
  nativeKeepAwake,
  nativePrepareHoldToTalk,
  nativeStartCall,
  resetNativeHoldPrep,
} from "./native-shell.ts";

describe("native call bridge", { concurrency: 1 }, () => {
  test("web has no native shell", () => {
    assert.equal(isNativeShell(), false);
  });

  test("native shell takes the call only when the switch is on", () => {
    assert.deepEqual(nativeCallPlan(false), { callStart: "prepareAudio", callEnd: "none" });
    assert.deepEqual(nativeCallPlan(true), { callStart: "prepareAudio", callEnd: "none" });
    const prev = globalThis.window;
    (globalThis as { window?: Window }).window = { QingranNative: { present: true } } as unknown as Window;
    try {
      assert.deepEqual(nativeCallPlan(false), { callStart: "prepareAudio", callEnd: "none" });
      assert.deepEqual(nativeCallPlan(true), { callStart: "startNativeCall", callEnd: "endNativeCall" });
    } finally {
      if (prev === undefined) delete (globalThis as { window?: Window }).window;
      else (globalThis as { window?: Window }).window = prev;
    }
  });

  test("start and end call the bridge only for the planned action", () => {
    const calls: string[] = [];
    const bridge = {
      present: true,
      startCall: () => calls.push("startCall"),
      endCall: () => calls.push("endCall"),
      prepareAudio: () => calls.push("prepareAudio"),
      startNativeCall: () => calls.push("startNativeCall"),
      endNativeCall: () => calls.push("endNativeCall"),
    };
    const prev = globalThis.window;
    (globalThis as { window?: Window }).window = { QingranNative: bridge } as unknown as Window;
    try {
      nativeStartCall(false);
      nativeEndCall(false);
      nativeStartCall(true);
      nativeEndCall(true);
    } finally {
      if (prev === undefined) delete (globalThis as { window?: Window }).window;
      else (globalThis as { window?: Window }).window = prev;
    }
    assert.deepEqual(calls, ["prepareAudio", "startNativeCall", "endNativeCall"]);
  });

  test("push-to-talk prepares audio once", () => {
    const calls: string[] = [];
    const prev = globalThis.window;
    (globalThis as { window?: Window }).window = {
      QingranNative: {
        present: true,
        prepareAudio: () => calls.push("prepareAudio"),
      },
    } as unknown as Window;
    resetNativeHoldPrep();
    try {
      assert.equal(nativePrepareHoldToTalk(), true);
      assert.equal(nativePrepareHoldToTalk(), false);
    } finally {
      resetNativeHoldPrep();
      if (prev === undefined) delete (globalThis as { window?: Window }).window;
      else (globalThis as { window?: Window }).window = prev;
    }
    assert.deepEqual(calls, ["prepareAudio"]);
  });

  test("background calls use the native pipeline when the shell is present", () => {
    assert.equal(lockedProfile().callKitBackground, false);
    assert.equal(lockedProfile({ callKitBackground: true }).callKitBackground, true);
    const call = readFileSync(new URL("../../hooks/use-call.ts", import.meta.url), "utf8");
    const voice = readFileSync(new URL("../../hooks/use-voice-input.ts", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../components/lover/settings-drawer.tsx", import.meta.url), "utf8");
    const room = readFileSync(new URL("../../components/lover/voice-room.tsx", import.meta.url), "utf8");
    const web = readFileSync(new URL("../../../ios/Qingran/Qingran/WebContainer.swift", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../../ios/Qingran/Qingran/AppDelegate.swift", import.meta.url), "utf8");
    assert.match(call, /nativeStartCall\(callKitRef\.current\)/);
    assert.match(call, /nativeEndCall\(callKitRef\.current\)/);
    assert.match(call, /nativeOwned/);
    assert.match(call, /nativeKeepAwake\(true\)/);
    assert.match(call, /nativeKeepAwake\(false\)/);
    assert.doesNotMatch(call, /nativeStartCall\(\)/);
    assert.match(voice, /nativePrepareHoldToTalk\(\)/);
    assert.match(room, /callKitBackground: profile\.callKitBackground/);
    assert.match(room, /qingran-native-call/);
    assert.match(settings, /切到后台也继续通话/);
    assert.match(settings, /开启后通话由手机原生处理/);
    assert.match(web, /case "keepAwake"/);
    assert.match(web, /isIdleTimerDisabled = on/);
    assert.match(web, /keepAwake: function/);
    assert.match(web, /startNativeCall/);
    assert.match(web, /endNativeCall/);
    const native = readFileSync(new URL("../../../ios/Qingran/Qingran/NativeCall.swift", import.meta.url), "utf8");
    assert.match(native, /api\/stt/);
    assert.match(native, /api\/talk/);
    assert.match(native, /api\/native-log/);
    assert.match(native, /NativeVad.silenceMs/);
    assert.match(app, /func applicationDidEnterBackground/);
    assert.match(app, /isIdleTimerDisabled = false/);
  });

  test("keepAwake forwards the flag", () => {
    const calls: boolean[] = [];
    const prev = globalThis.window;
    (globalThis as { window?: Window }).window = {
      QingranNative: {
        present: true,
        keepAwake: (on: boolean) => calls.push(on),
      },
    } as unknown as Window;
    try {
      nativeKeepAwake(true);
      nativeKeepAwake(false);
    } finally {
      if (prev === undefined) delete (globalThis as { window?: Window }).window;
      else (globalThis as { window?: Window }).window = prev;
    }
    assert.deepEqual(calls, [true, false]);
  });
});

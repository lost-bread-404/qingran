import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { lockedProfile } from "./types.ts";
import {
  isNativeShell,
  nativeCallPlan,
  nativeEndCall,
  nativePrepareHoldToTalk,
  nativeStartCall,
  resetNativeHoldPrep,
} from "./native-shell.ts";

describe("native call bridge", { concurrency: 1 }, () => {
  test("web has no native shell", () => {
    assert.equal(isNativeShell(), false);
  });

  test("CallKit stays off unless the background switch is on", () => {
    assert.deepEqual(nativeCallPlan(false), { callStart: "prepareAudio", callEnd: "none" });
    assert.deepEqual(nativeCallPlan(true), { callStart: "startCall", callEnd: "endCall" });
  });

  test("start and end call the bridge only for the planned action", () => {
    const calls: string[] = [];
    const bridge = {
      present: true,
      startCall: () => calls.push("startCall"),
      endCall: () => calls.push("endCall"),
      prepareAudio: () => calls.push("prepareAudio"),
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
    assert.deepEqual(calls, ["prepareAudio", "startCall", "endCall"]);
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

  test("background calls default off and the page wires the switch", () => {
    assert.equal(lockedProfile().callKitBackground, false);
    assert.equal(lockedProfile({ callKitBackground: true }).callKitBackground, true);
    const call = readFileSync(new URL("../../hooks/use-call.ts", import.meta.url), "utf8");
    const voice = readFileSync(new URL("../../hooks/use-voice-input.ts", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../components/lover/settings-drawer.tsx", import.meta.url), "utf8");
    const room = readFileSync(new URL("../../components/lover/voice-room.tsx", import.meta.url), "utf8");
    assert.match(call, /nativeStartCall\(callKitRef\.current\)/);
    assert.match(call, /nativeEndCall\(callKitRef\.current\)/);
    assert.doesNotMatch(call, /nativeStartCall\(\)/);
    assert.match(voice, /nativePrepareHoldToTalk\(\)/);
    assert.match(room, /callKitBackground: profile\.callKitBackground/);
    assert.match(settings, /切到后台也继续通话/);
    assert.match(settings, /开启后会显示系统通话界面，锁屏或切到其他 app 也不会断。/);
  });
});

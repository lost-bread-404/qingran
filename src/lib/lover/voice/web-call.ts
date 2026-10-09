/**
 * A call in the browser (the iPhone shell runs its own the same way, ios/Qingran/Qingran/Voice.swift). Her voice
 * streams to xAI and xAI's turn model says when a line is finished; nothing here decides from loudness when she
 * speaks. Only two things are local:
 * - while his voice is in the room, and half a second after, nothing is sent (he must never be heard as her);
 * - after 30 s with no word the stream is closed, so a silent room (she fell asleep on the call) costs nothing; any
 *   sound opens it again, with the 1.5 s before it, so the first word is heard too.
 */
import { Ear } from "./ear-client.ts";
import { mic, type MicFrame } from "./mic.ts";

const STANDBY_MS = 30_000;
const AFTER_HIM_MS = 500;
/** 1.5 s of 100 ms frames. */
const RING = 15;
/** A stream through the server lasts at most 5 minutes (the function's limit): a new one is opened between lines. */
const ROTATE_MS = 240_000;

export type WebCallHooks = {
  /** What she is saying right now (empty: nothing). */
  onLive: (text: string) => void;
  /** A line she finished. */
  onLine: (text: string) => void;
  onError: (message: string) => void;
};

export class WebCall {
  /** Seconds of her voice sent to xAI since the last turn (its cost goes with the turn). */
  sec = 0;
  private ear: Ear | null = null;
  private awake = true;
  private ring: Int16Array<ArrayBuffer>[] = [];
  private floor = 0.004;
  private deafUntil = 0;
  private heardAt = 0;
  private lineOpen = false;
  private retryAt = 0;
  private retryMs = 1000;
  private warned = false;
  private stopped = false;
  private settings: () => { wait: number; keyterms: readonly string[] };
  private hooks: WebCallHooks;

  constructor(settings: () => { wait: number; keyterms: readonly string[] }, hooks: WebCallHooks) {
    this.settings = settings;
    this.hooks = hooks;
  }

  /** From her tap (the mic needs it). */
  async start() {
    this.heardAt = performance.now();
    mic.onFrame = (frame) => this.frame(frame);
    await mic.start();
  }

  /** Back in front: if the browser took the mic away meanwhile, it is opened again. */
  async revive() {
    if (this.stopped || mic.alive) return;
    mic.stop();
    mic.onFrame = (frame) => this.frame(frame);
    await mic.start();
  }

  stop() {
    this.stopped = true;
    mic.onFrame = null;
    mic.stop();
    this.ear?.close();
    this.ear = null;
    this.hooks.onLive("");
  }

  /** His voice started (true) or ended (false: she is listened to again half a second later). */
  deaf(on: boolean) {
    if (on) {
      this.deafUntil = Number.POSITIVE_INFINITY;
      this.closeEar();
      return;
    }
    this.deafUntil = performance.now() + AFTER_HIM_MS;
    this.awake = true;
    this.heardAt = this.deafUntil;
  }

  /** The seconds since the last turn, counted once. */
  takeSeconds(): number {
    const sec = Math.round(this.sec * 10) / 10;
    this.sec = 0;
    return sec;
  }

  private frame({ pcm, rms }: MicFrame) {
    if (this.stopped) return;
    const now = performance.now();
    if (now < this.deafUntil) {
      this.ring = [];
      return;
    }
    if (!this.ear) {
      this.ring.push(pcm);
      if (this.ring.length > RING) this.ring.shift();
      if (!this.awake) {
        // Asleep: the room's level is followed (down fast, up slowly) and any sound well above it wakes the stream.
        this.floor = rms < this.floor ? this.floor * 0.7 + rms * 0.3 : this.floor * 0.995 + rms * 0.005;
        if (rms <= Math.max(0.004, this.floor * 2.5)) return;
        this.awake = true;
        this.heardAt = now;
      }
      if (now < this.retryAt) return;
      this.openEar();
      const earlier = this.ring;
      this.ring = [];
      for (const piece of earlier) this.sendTo(piece);
      return;
    }
    this.sendTo(pcm);
    if (this.ear.live) this.retryMs = 1000;
    if (this.lineOpen) return;
    if (now - Math.max(this.heardAt, this.ear.wordsAt) > STANDBY_MS) {
      this.awake = false;
      this.closeEar();
    } else if (now - this.ear.born > ROTATE_MS) {
      this.closeEar();
    }
  }

  private sendTo(pcm: Int16Array<ArrayBuffer>) {
    if (!this.ear) return;
    this.ear.send(pcm);
    this.sec += pcm.length / 16000;
  }

  private openEar() {
    const { wait, keyterms } = this.settings();
    const ear: Ear = new Ear("call", { wait, keyterms }, {
      onText: (text) => {
        if (this.stopped || this.ear !== ear) return;
        this.lineOpen = Boolean(text);
        if (text) this.heardAt = performance.now();
        this.hooks.onLive(text);
      },
      // A stream already let go may still bring the end of a line.
      onLine: (text) => {
        if (this.stopped) return;
        if (this.ear === ear) this.lineOpen = false;
        this.heardAt = performance.now();
        this.hooks.onLine(text);
      },
      onDead: () => {
        if (this.ear !== ear || this.stopped) return;
        this.ear = null;
        this.lineOpen = false;
        this.hooks.onLive("");
        this.retryAt = performance.now() + this.retryMs;
        this.retryMs = Math.min(30_000, this.retryMs * 2);
        if (!this.warned) {
          this.warned = true;
          this.hooks.onError("听写连不上，正在重连。");
        }
      },
    });
    this.ear = ear;
  }

  /** The stream is let go; what it already heard still comes back (a line she had not finished is still a line). */
  private closeEar() {
    const ear = this.ear;
    this.ear = null;
    this.lineOpen = false;
    this.hooks.onLive("");
    if (ear) void ear.finish(3000).then(() => ear.close());
  }
}

/**
 * xAI's recognizer from the browser, through server/routes/api/listen.ts (a page cannot put the key in a WebSocket
 * header). Her audio waits until xAI says the stream is ready, then goes up as it is captured; words come back as xAI
 * hears them. The iPhone shell has the same client in Swift (ios/Qingran/Qingran/Voice.swift).
 */
import { lockKeyterms, tidyHeard, type EarMode } from "../ear.ts";

export type EarHooks = {
  /**
   * What she is saying, so far: the words xAI has locked, then its live guess. Holding: everything since the press.
   * A call: the line in progress (empty once it is done).
   */
  onText?: (live: string) => void;
  /** A call: xAI's turn model says she finished this line. */
  onLine?: (text: string) => void;
  /** The stream stopped working before it was finished. */
  onDead?: (why: string) => void;
};

/** Pieces of a line run together; a space only between two Latin words. */
export function joinHeard(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? `${a} ${b}` : a + b;
}

const READY_TIMEOUT_MS = 6000;
/** At most this much audio waits for the stream to open (60 s). */
const QUEUE_MAX = 600;

type XaiEvent = { type?: string; text?: unknown; is_final?: unknown; speech_final?: unknown; message?: unknown };

export class Ear {
  /** Seconds of her voice sent to xAI (what it bills). */
  sent = 0;
  /** When xAI last heard a word (performance.now()). */
  wordsAt = performance.now();
  /** When the stream was opened (performance.now()). */
  readonly born = performance.now();
  private mode: EarMode;
  private ws: WebSocket;
  private ready = false;
  private closed = false;
  private dead = false;
  private queue: Int16Array<ArrayBuffer>[] = [];
  /** Locked pieces of the call's line in progress. */
  private line = "";
  /** Every locked piece since the stream opened. */
  private whole = "";
  private finishing: ((text: string | null) => void) | null = null;
  private finishTimer = 0;
  private readyTimer = 0;
  private hooks: EarHooks;

  constructor(mode: EarMode, opts: { wait?: number; keyterms?: readonly string[] }, hooks: EarHooks) {
    this.mode = mode;
    this.hooks = hooks;
    const params = new URLSearchParams({ mode });
    if (opts.wait) params.set("wait", String(opts.wait));
    for (const term of lockKeyterms(opts.keyterms ?? [])) params.append("k", term);
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${scheme}://${location.host}/api/listen?${params.toString()}`);
    this.ws.onmessage = (event) => {
      if (typeof event.data === "string") this.handle(event.data);
    };
    this.ws.onclose = () => this.die("closed");
    this.ws.onerror = () => this.die("error");
    this.readyTimer = window.setTimeout(() => {
      if (!this.ready) this.die("timeout");
    }, READY_TIMEOUT_MS);
  }

  /** The stream is up (xAI has started listening). */
  get live(): boolean {
    return this.ready && !this.dead && !this.closed;
  }

  /** 100 ms of her voice. Kept until the stream is ready. */
  send(pcm: Int16Array<ArrayBuffer>) {
    if (this.closed || this.dead) return;
    if (!this.ready) {
      this.queue.push(pcm);
      if (this.queue.length > QUEUE_MAX) this.queue.shift();
      return;
    }
    this.push(pcm);
  }

  /**
   * She is done (released, or the call stops listening): the rest is heard and the whole text comes back. Null when the
   * stream did not finish (never opened, broke, or too slow): the caller has the audio and reads it whole instead.
   */
  finish(timeoutMs = 3000): Promise<string | null> {
    if (this.closed || this.dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.finishing = resolve;
      this.finishTimer = window.setTimeout(() => this.settle(null), timeoutMs);
      if (this.ready) this.sendDone();
    });
  }

  /** Dropped (cancelled, hung up, or finished): nothing more is heard or reported. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.settle(null);
    window.clearTimeout(this.readyTimer);
    this.queue = [];
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }

  private push(pcm: Int16Array<ArrayBuffer>) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(pcm);
      this.sent += pcm.length / 16000;
    } catch {
      this.die("send");
    }
  }

  private sendDone() {
    try {
      this.ws.send(JSON.stringify({ type: "audio.done" }));
    } catch {
      this.die("send");
    }
  }

  /** What is shown while she speaks: the locked words, then xAI's live guess for the rest. */
  private shown(guess: string): string {
    return tidyHeard(joinHeard(this.mode === "hold" ? this.whole : this.line, guess));
  }

  private handle(raw: string) {
    if (this.closed) return;
    let event: XaiEvent;
    try {
      event = JSON.parse(raw) as XaiEvent;
    } catch {
      return;
    }
    if (event.type === "transcript.created") {
      this.ready = true;
      window.clearTimeout(this.readyTimer);
      const waiting = this.queue;
      this.queue = [];
      for (const pcm of waiting) this.push(pcm);
      if (this.finishing) this.sendDone();
      return;
    }
    if (event.type === "transcript.partial") {
      const text = typeof event.text === "string" ? event.text.trim() : "";
      if (text) this.wordsAt = performance.now();
      if (event.is_final !== true) {
        this.hooks.onText?.(this.shown(text));
        return;
      }
      if (text) {
        this.line = joinHeard(this.line, text);
        this.whole = joinHeard(this.whole, text);
      }
      if (event.speech_final === true && this.mode === "call") {
        // The line first, then that she is no longer saying one (a reply waiting for her ends either way).
        const said = tidyHeard(this.line);
        this.line = "";
        if (said) this.hooks.onLine?.(said);
        this.hooks.onText?.("");
        return;
      }
      this.hooks.onText?.(this.shown(""));
      return;
    }
    if (event.type === "transcript.done") {
      const done = typeof event.text === "string" ? event.text.trim() : "";
      if (this.mode === "call") {
        // A line still open when the stream ends is still a line.
        const open = tidyHeard(this.line);
        this.line = "";
        if (open) {
          this.hooks.onLine?.(open);
          this.hooks.onText?.("");
        }
      }
      // The longer of the two: the final text, or every piece locked on the way (in case either is cut short).
      this.settle(tidyHeard(done.length >= this.whole.length ? done : this.whole));
      this.close();
      return;
    }
    if (event.type === "error") {
      this.die(typeof event.message === "string" ? event.message : "error");
    }
  }

  private settle(text: string | null) {
    const resolve = this.finishing;
    this.finishing = null;
    window.clearTimeout(this.finishTimer);
    resolve?.(text);
  }

  private die(why: string) {
    if (this.closed || this.dead) return;
    this.dead = true;
    window.clearTimeout(this.readyTimer);
    this.settle(null);
    this.hooks.onDead?.(why);
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

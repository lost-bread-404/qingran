import { defineWebSocketHandler } from "nitro";
import WebSocket from "ws";
import { parseCookie, verifySession } from "../../../src/lib/auth-lite/session.ts";
import { EAR_STREAM_URL, earMode, earQuery } from "../../../src/lib/lover/ear.ts";

/**
 * The browser's way to xAI's recognizer (a browser cannot put the key in a WebSocket header). The page opens
 * wss://…/api/listen?mode=hold|call&wait=…&k=…; this passes her audio up and xAI's words down, unchanged. The login is
 * checked here, on the upgrade (the site's password gate lets this one request through). The iPhone shell does not
 * come here: it connects to xAI itself with a ticket from /api/stt-stream.
 */

type Link = { up: WebSocket; waiting: Array<string | Buffer> };
const links = new WeakMap<object, Link>();

function sendText(peer: { send: (data: string) => unknown }, data: string) {
  try {
    peer.send(data);
  } catch {
    /* the page is gone */
  }
}

export default defineWebSocketHandler({
  upgrade(request) {
    // Production always has APP_PASSWORD (without it the gate refuses everything, this included); a local copy has none.
    const password = process.env.APP_PASSWORD?.trim();
    if (password && !verifySession(parseCookie(request.headers.get("cookie")), password)) {
      throw new Response("unauthorized", { status: 401 });
    }
  },
  open(peer) {
    const url = new URL(peer.request?.url ?? "/", "http://localhost");
    const key = process.env.XAI_API_KEY;
    if (!key) {
      sendText(peer, JSON.stringify({ type: "error", message: "服务器没有 XAI_API_KEY。" }));
      peer.close();
      return;
    }
    const query = earQuery(earMode(url.searchParams.get("mode")), {
      wait: url.searchParams.get("wait"),
      keyterms: url.searchParams.getAll("k"),
    });
    const up = new WebSocket(`${EAR_STREAM_URL}?${query}`, { headers: { Authorization: `Bearer ${key}` } });
    const link: Link = { up, waiting: [] };
    links.set(peer, link);
    up.on("open", () => {
      for (const item of link.waiting) up.send(item);
      link.waiting = [];
    });
    up.on("message", (data, isBinary) => {
      if (!isBinary) sendText(peer, data.toString());
    });
    up.on("error", (err) => {
      sendText(peer, JSON.stringify({ type: "error", message: `xAI：${err.message}` }));
    });
    up.on("close", () => {
      try {
        peer.close();
      } catch {
        /* already closed */
      }
    });
  },
  message(peer, message) {
    const link = links.get(peer);
    if (!link) return;
    // Text frames are xAI's control messages (audio.done); binary frames are her audio.
    const data = typeof message.rawData === "string" ? message.rawData : Buffer.from(message.uint8Array());
    if (link.up.readyState === WebSocket.OPEN) link.up.send(data);
    else if (link.up.readyState === WebSocket.CONNECTING) link.waiting.push(data);
  },
  close(peer) {
    const link = links.get(peer);
    links.delete(peer);
    try {
      link?.up.close();
    } catch {
      /* already closed */
    }
  },
});

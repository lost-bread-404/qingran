import http2 from "node:http2";
import { createSign } from "node:crypto";
import { dropPushDevice, listPushDevices, markPushDevice } from "../brain/life-store.ts";

type ApnsConfig = {
  keyId: string;
  teamId: string;
  key: string;
  bundleId: string;
};

let cached: { token: string; until: number } | null = null;

export function apnsConfig(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID?.trim() ?? "";
  const teamId = process.env.APNS_TEAM_ID?.trim() ?? "";
  const key = (process.env.APNS_KEY_P8 ?? "").replace(/\\n/g, "\n").trim();
  const bundleId = process.env.APNS_BUNDLE_ID?.trim() ?? "";
  if (!keyId || !teamId || !key || !bundleId) return null;
  return { keyId, teamId, key, bundleId };
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

export function apnsJwt(config: ApnsConfig, at = Date.now()): string {
  if (cached && cached.until > at) return cached.token;
  const header = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const body = b64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(at / 1000) }));
  const sign = createSign("SHA256");
  sign.update(`${header}.${body}`);
  sign.end();
  const token = `${header}.${body}.${b64url(sign.sign(config.key))}`;
  cached = { token, until: at + 50 * 60_000 };
  return token;
}

export function pushAlertBody(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 120) return flat;
  return `${flat.slice(0, 119)}…`;
}

function hostFor(env: string): string {
  return env === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
}

function postApns(host: string, token: string, jwt: string, topic: string, payload: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(host);
    const timer = setTimeout(() => {
      client.close();
      reject(new Error("apns-timeout"));
    }, 10_000);
    client.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    const chunks: Buffer[] = [];
    req.on("response", (headers) => {
      const status = Number(headers[":status"] ?? 0);
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        clearTimeout(timer);
        client.close();
        resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      client.close();
      reject(err);
    });
    req.end(payload);
  });
}

export async function sendApns(input: { title?: string; body: string; messageId?: string }): Promise<string> {
  const config = apnsConfig();
  if (!config) return "no-config";
  const devices = await listPushDevices();
  if (!devices.length) return "no-device";
  const alert = pushAlertBody(input.body);
  const payload = JSON.stringify({
    aps: {
      alert: { title: input.title || "清然", body: alert },
      sound: "default",
      "thread-id": "qingran",
    },
    mid: input.messageId ?? "",
  }).slice(0, 4000);
  const jwt = apnsJwt(config);
  const results: string[] = [];
  for (const device of devices) {
    try {
      const res = await postApns(hostFor(device.env), device.token, jwt, config.bundleId, payload);
      let reason = "";
      try {
        reason = String((JSON.parse(res.body) as { reason?: string }).reason ?? "");
      } catch {
        reason = res.body.slice(0, 80);
      }
      if (res.status === 200) {
        await markPushDevice(device.token, null);
        results.push("ok");
      } else if (res.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") {
        await dropPushDevice(device.token);
        results.push(`drop:${reason || res.status}`);
      } else {
        await markPushDevice(device.token, reason || String(res.status));
        results.push(`err:${res.status}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markPushDevice(device.token, message);
      results.push("err");
    }
  }
  return results.join(",") || "no-device";
}

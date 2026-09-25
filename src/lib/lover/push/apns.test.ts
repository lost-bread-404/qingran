import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { apnsJwt } from "./apns.ts";

test("APNs ES256 signature is 64-byte IEEE P1363, not DER", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  const token = apnsJwt(
    { keyId: "KEYID123", teamId: "TEAMID1234", key: String(key), bundleId: "app.qingran.ios" },
    Date.now() + 86_400_000,
  );
  const signature = Buffer.from(token.split(".")[2] ?? "", "base64url");
  assert.equal(signature.length, 64);
});

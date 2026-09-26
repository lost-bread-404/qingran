import { getSql } from "../db.ts";

/**
 * Who pays for an xAI call. Her SuperGrok subscription first (xAI's device login, the same one
 * Grok CLI / Hermes / Warp use; the token works as a Bearer on api.x.ai), then the API key.
 * When the subscription is refused (weekly pool used up, tier not allowed, rate limit), the same
 * request is sent again with the API key, and the subscription is tried again a while later.
 */

const ISSUER = "https://auth.x.ai";
const DEVICE_URL = `${ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
/** Refresh this long before the access token runs out (tokens live about 6 hours). */
const REFRESH_EARLY_MS = 60 * 60_000;

export type XaiCred = { kind: "sub" | "api"; token: string };

type LoginRow = {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  device_code: string | null;
  user_code: string | null;
  verify_url: string | null;
  device_expires_at: number | null;
  poll_interval: number | null;
  refused_until: number | null;
  refused_note: string | null;
  updated_at: number | null;
};

async function loadRow(): Promise<LoginRow> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(`select * from qr_xai_login where id = 1`);
  const r = rows[0] ?? {};
  const num = (v: unknown) => (v == null ? null : Number(v));
  const str = (v: unknown) => (v == null || v === "" ? null : String(v));
  return {
    access_token: str(r.access_token),
    refresh_token: str(r.refresh_token),
    expires_at: num(r.expires_at),
    device_code: str(r.device_code),
    user_code: str(r.user_code),
    verify_url: str(r.verify_url),
    device_expires_at: num(r.device_expires_at),
    poll_interval: num(r.poll_interval),
    refused_until: num(r.refused_until),
    refused_note: str(r.refused_note),
    updated_at: num(r.updated_at),
  };
}

async function saveRow(patch: Partial<LoginRow>): Promise<void> {
  const keys = Object.keys(patch) as Array<keyof LoginRow>;
  if (!keys.length) return;
  const db = await getSql();
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  await db.query(
    `insert into qr_xai_login (id) values (1) on conflict (id) do nothing`,
  );
  await db.query(`update qr_xai_login set ${sets}, updated_at = $${keys.length + 1} where id = 1`, [
    ...keys.map((k) => patch[k] ?? null),
    Date.now(),
  ]);
}

async function tokenRequest(form: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...form }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const json = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  return { status: res.status, json };
}

function tokensFrom(json: Record<string, unknown>, previousRefresh: string | null): Partial<LoginRow> | null {
  const access = typeof json.access_token === "string" ? json.access_token : "";
  if (!access) return null;
  const refresh = typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : previousRefresh;
  const life = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 6 * 3600_000;
  return { access_token: access, refresh_token: refresh, expires_at: Date.now() + life };
}

/** The subscription token, refreshed when it is close to running out. Null when not signed in or resting after a refusal. */
async function subscriptionToken(): Promise<string | null> {
  const row = await loadRow().catch(() => null);
  if (!row?.access_token || !row.refresh_token) return null;
  if (row.refused_until && row.refused_until > Date.now()) return null;
  if (row.expires_at && row.expires_at - Date.now() > REFRESH_EARLY_MS) return row.access_token;
  try {
    const got = await tokenRequest({ grant_type: "refresh_token", refresh_token: row.refresh_token });
    const tokens = got.status === 200 ? tokensFrom(got.json, row.refresh_token) : null;
    if (tokens) {
      await saveRow(tokens);
      return tokens.access_token ?? null;
    }
    const why = String(got.json.error ?? got.status);
    if (got.status === 400 || got.status === 401 || got.status === 403) {
      // The grant is gone (revoked, expired, tier): she signs in again from the spend page.
      await saveRow({ access_token: null, refresh_token: null, expires_at: null, refused_note: `登录失效（${why}），要重新连接` });
      return null;
    }
    await saveRow({ refused_until: Date.now() + 10 * 60_000, refused_note: `刷新失败（${why}）` });
    return null;
  } catch {
    return row.expires_at && row.expires_at > Date.now() ? row.access_token : null;
  }
}

/** In the order they should be tried. */
export async function xaiCreds(): Promise<XaiCred[]> {
  const out: XaiCred[] = [];
  const sub = await subscriptionToken();
  if (sub) out.push({ kind: "sub", token: sub });
  const key = process.env.XAI_API_KEY;
  if (key) out.push({ kind: "api", token: key });
  return out;
}

/** Statuses that mean "not on the subscription": use the key this time. */
export function subscriptionRefusedStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

export async function noteSubscriptionRefused(status: number, detail: string): Promise<void> {
  const rest = status === 401 ? 0 : status === 429 ? 15 * 60_000 : 60 * 60_000;
  const note = `${status} ${detail.replace(/\s+/g, " ").slice(0, 200)}`.trim();
  await saveRow(
    status === 401
      ? { expires_at: 0, refused_note: note }
      : { refused_until: Date.now() + rest, refused_note: note },
  ).catch(() => undefined);
}

/**
 * fetch with the subscription first and the API key after it. The body must be a string or form data
 * (sent again unchanged on the second try). Returns null when there is no credential at all.
 */
export async function xaiFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | FormData; signal?: AbortSignal },
): Promise<{ res: Response; cred: XaiCred } | null> {
  const creds = await xaiCreds();
  for (let i = 0; i < creds.length; i += 1) {
    const cred = creds[i]!;
    const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${cred.token}` } });
    if (cred.kind === "sub" && i < creds.length - 1 && subscriptionRefusedStatus(res.status)) {
      await noteSubscriptionRefused(res.status, await res.text().catch(() => ""));
      continue;
    }
    return { res, cred };
  }
  return null;
}

// ---------- signing in (device code) ----------

export type XaiLoginStatus = {
  connected: boolean;
  /** Resting on the API key until this time after a refusal. */
  refusedUntil: number | null;
  note: string | null;
  pending: { userCode: string; url: string; expiresAt: number } | null;
  hasApiKey: boolean;
};

export async function xaiLoginStatus(): Promise<XaiLoginStatus> {
  const row = await loadRow();
  const pending =
    row.device_code && row.user_code && row.verify_url && (row.device_expires_at ?? 0) > Date.now()
      ? { userCode: row.user_code, url: row.verify_url, expiresAt: row.device_expires_at ?? 0 }
      : null;
  return {
    connected: Boolean(row.access_token && row.refresh_token),
    refusedUntil: row.refused_until && row.refused_until > Date.now() ? row.refused_until : null,
    note: row.refused_note,
    pending,
    hasApiKey: Boolean(process.env.XAI_API_KEY),
  };
}

export async function xaiLoginStart(): Promise<XaiLoginStatus> {
  const res = await fetch(DEVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const json = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const deviceCode = typeof json.device_code === "string" ? json.device_code : "";
  if (!res.ok || !deviceCode) throw new Error(`xAI 登录没开始（${res.status} ${String(json.error ?? "")}）`);
  const url = String(json.verification_uri_complete || json.verification_uri || "https://accounts.x.ai");
  await saveRow({
    device_code: deviceCode,
    user_code: String(json.user_code ?? ""),
    verify_url: url,
    device_expires_at: Date.now() + (Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 10 * 60_000),
    poll_interval: Number(json.interval) > 0 ? Number(json.interval) : 5,
  });
  return xaiLoginStatus();
}

/** Called by the page every few seconds while she approves in the browser. */
export async function xaiLoginPoll(): Promise<XaiLoginStatus> {
  const row = await loadRow();
  if (!row.device_code || (row.device_expires_at ?? 0) <= Date.now()) return xaiLoginStatus();
  const got = await tokenRequest({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: row.device_code });
  const tokens = got.status === 200 ? tokensFrom(got.json, null) : null;
  if (tokens) {
    await saveRow({ ...tokens, device_code: null, user_code: null, verify_url: null, device_expires_at: null, refused_until: null, refused_note: null });
  } else {
    const error = String(got.json.error ?? "");
    if (error && error !== "authorization_pending" && error !== "slow_down") {
      await saveRow({ device_code: null, user_code: null, verify_url: null, device_expires_at: null, refused_note: `登录没完成（${error}）` });
    }
  }
  return xaiLoginStatus();
}

export async function xaiLogout(): Promise<XaiLoginStatus> {
  await saveRow({
    access_token: null,
    refresh_token: null,
    expires_at: null,
    device_code: null,
    user_code: null,
    verify_url: null,
    device_expires_at: null,
    refused_until: null,
    refused_note: null,
  });
  return xaiLoginStatus();
}

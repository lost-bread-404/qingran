import { getProfileData } from "./brain/store.ts";
import { recordSttSpend } from "./brain/spend/check.ts";
import { lockedProfile } from "./types.ts";
import { xaiCreds, xaiFetch } from "./xai-auth.ts";
import { isQuotaHint, readXaiFail } from "./xai-error.ts";
import { EAR_CLIP_URL, EAR_MODEL, EAR_STREAM_URL, earQuery, lockKeyterms, tidyHeard, type EarMode } from "./ear.ts";

/** Her words to listen for and her pause, as she saved them (设置 → 声音和听力). */
export async function earSettings(): Promise<{ wait: number; keyterms: string[] }> {
  const profile = lockedProfile(await getProfileData().catch(() => ({})));
  return { wait: profile.silenceMs, keyterms: profile.sttKeyterms };
}

const CLIENT_SECRET_URL = "https://api.x.ai/v1/realtime/client_secrets";
/** How long a ticket lives. The phone takes a fresh one when the one it holds has less than 90 s left. */
const TICKET_SECONDS = 300;

export type EarTicket = { url: string; token: string; expiresAt: number };

/** The iPhone shell's stream: its address and a secret that lasts a few minutes, so the phone holds no API key. */
export async function earTicket(mode: EarMode): Promise<EarTicket | null> {
  const [settings, creds] = await Promise.all([earSettings(), xaiCreds()]);
  // Each credential in turn (SuperGrok first), without marking the subscription refused for everything else.
  for (const cred of creds) {
    try {
      const res = await fetch(CLIENT_SECRET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred.token}` },
        body: JSON.stringify({ expires_after: { seconds: TICKET_SECONDS } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const nested = (json.client_secret ?? {}) as Record<string, unknown>;
      const token = [json.value, nested.value, json.secret, json.token].find((v) => typeof v === "string" && v) as
        | string
        | undefined;
      if (!token) continue;
      const at = Number(json.expires_at ?? nested.expires_at);
      const expiresAt = Number.isFinite(at) && at > 0 ? (at < 1e12 ? at * 1000 : at) : Date.now() + TICKET_SECONDS * 1000;
      return { url: `${EAR_STREAM_URL}?${earQuery(mode, settings)}`, token, expiresAt };
    } catch {
      /* next credential */
    }
  }
  return null;
}

export type ClipHeard = { ok: true; text: string } | { ok: false; error: string; quota?: boolean };

/**
 * A whole clip (16 kHz 16-bit WAV), read at once: only when the stream could not be opened (holding to talk keeps the
 * audio until the words are in, so nothing she said is lost).
 */
export async function hearWholeClip(audioBase64: string): Promise<ClipHeard> {
  const bytes = Buffer.from(audioBase64, "base64");
  if (bytes.length < 1000) return { ok: true, text: "" };
  if (bytes.length > 20_000_000) return { ok: false, error: "这段太长了。" };
  const { keyterms } = await earSettings();
  const form = new FormData();
  form.append("model", EAR_MODEL);
  form.append("filler_words", "true");
  for (const term of lockKeyterms(keyterms)) form.append("keyterm", term);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "clip.wav");
  try {
    const sent = await xaiFetch(EAR_CLIP_URL, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    if (!sent) return { ok: false, error: "这会儿连不上 xAI。" };
    if (!sent.res.ok) {
      const hint = await readXaiFail(sent.res);
      return isQuotaHint(hint) ? { ok: false, error: hint, quota: true } : { ok: false, error: `没听清（${sent.res.status}）。` };
    }
    const body = (await sent.res.json()) as { text?: string; transcript?: string };
    // 16-bit mono at 16 kHz after the 44-byte header.
    void recordSttSpend(Math.max(0, bytes.length - 44) / 32_000, false, null, sent.cred.kind);
    return { ok: true, text: tidyHeard(body.text || body.transcript || "") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "这会儿连不上 xAI。" };
  }
}
